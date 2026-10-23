import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  ValidationRecorder,
  aggregateValidation,
} from "../apps/worker/src/validation.ts";
import { DashboardService } from "../apps/worker/src/dashboard-feed.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import {
  withApiTiming,
  currentApiTiming,
  timeAggregation,
} from "../packages/shared/src/api-timing.ts";

it("invalidates display tokens for external updates, rollback and reopened services", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-display-")),
    path = join(dir, "isolated.sqlite");
  let db = new BotDatabase(path);
  const service = new DashboardService({} as never, db);
  try {
    const before = service.records();
    expect(service.records().version).toBe(before.version);
    const writer = new DatabaseSync(path);
    writer
      .prepare("INSERT INTO paper_orders VALUES(?,?,?)")
      .run("external", 10, '{"status":"REJECTED"}');
    writer.close();
    expect(service.records().version).not.toBe(before.version);
    const committed = service.records();
    // Repairs of existing records must invalidate too.
    const repair = new DatabaseSync(path);
    repair
      .prepare("UPDATE paper_orders SET json=? WHERE id=?")
      .run('{"status":"REPAIRED"}', "external");
    repair.close();
    expect(service.records().version).not.toBe(committed.version);
    const repaired = service.records();
    expect(() =>
      db.transaction(() => {
        db.append("paper_orders", "rollback", { status: "PENDING" }, 11);
        expect(service.records().records.orders.length).toBe(2);
        throw Error("rollback");
      }),
    ).toThrow("rollback");
    expect(service.records()).toEqual(repaired);
    db.close();
    expect(() => service.records()).toThrow();
    db = new BotDatabase(path);
    expect(new DashboardService({} as never, db).records()).toEqual(repaired);
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

it("does not parse malformed future rows before their SQL timestamp enters the window", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-future-")),
    path = join(dir, "isolated.sqlite");
  const db = new BotDatabase(path),
    r = new ValidationRecorder(db),
    start = 100000;
  try {
    r.begin(start);
    const writer = new DatabaseSync(path);
    writer
      .prepare("INSERT INTO validation_events VALUES(?,?,?)")
      .run("broken-future", start + 30000, "{");
    writer.close();
    expect(r.report(start + 10000, true)).toEqual(
      aggregateValidation(db, r.session(), start + 10000),
    );
    expect(() => r.report(start + 30000, true)).toThrow();
    expect(() => aggregateValidation(db, r.session(), start + 30000)).toThrow();
  } finally {
    db.close();
    rmSync(dir, { recursive: true });
  }
});

it("invalidates a warm display on a communication failure while the execution gate stays live", () => {
  const db = new BotDatabase(":memory:"),
    monitor = new OperationMonitor(db),
    r = new ValidationRecorder(db),
    now = Date.now();
  try {
    r.begin(now);
    const warm = r.report(now);
    db.set("runtime", { ...db.runtime(), running: true });
    monitor.market(now - 300000, now);
    expect(monitor.ordersAllowed(undefined, now)).toBe(true);
    monitor.transientFailure(
      "DeepBook Indexer",
      "UPSTREAM_BODY_TIMEOUT",
      {
        api: "DeepBook Indexer",
        host: "deepbook-indexer.mainnet.mystenlabs.com",
        url: "https://deepbook-indexer.mainnet.mystenlabs.com/[fixture]",
        operation: "OHLCV_FETCH",
        method: "GET",
        code: "UPSTREAM_BODY_TIMEOUT",
        phase: "BODY",
        timeoutType: "BODY",
        causeCode: null,
        status: null,
        elapsedMs: 8000,
        occurredAt: now,
      },
      now,
    );
    expect(monitor.ordersAllowed(undefined, now)).toBe(false);
    expect(r.report(now + 1)).not.toBe(warm);
    expect(monitor.safety().connectivity).toBe("DEGRADED");
  } finally {
    db.close();
  }
});

it("reuses unchanged validation inputs across TTL/fresh reads but preserves all time boundaries", () => {
  const db = new BotDatabase(":memory:"),
    r = new ValidationRecorder(db),
    start = 100000;
  try {
    r.begin(start);
    // Deliberately different SQL timestamp and JSON at, plus future events.
    db.append(
      "validation_events",
      "future",
      {
        kind: "api",
        at: start + 20000,
        data: {
          api: "fixture",
          success: false,
          occurredAt: start + 20000,
          latencyMs: 8,
          attempt: 0,
        },
        safelyStopped: true,
      },
      start + 30000,
    );
    const read = vi.spyOn(db, "displayValidationRows");
    for (const t of [1, 9999, 10000, 19999, 20000, 30000, 86445000, 0]) {
      const now = start + t;
      expect(r.report(now, true)).toEqual(
        aggregateValidation(db, r.session(), now),
      );
    }
    expect(read).toHaveBeenCalledTimes(1);
    const cached = r.report(start + 1);
    expect(r.report(start + 2)).toBe(cached);
    r.fault("NETWORK_SAVE_FAILED");
    expect(r.report(start + 3).integrityFault).toBe("NETWORK_SAVE_FAILED");
    expect(read).toHaveBeenCalledTimes(2);
    const restarted = new ValidationRecorder(db);
    expect(restarted.report(start + 4, true)).toEqual(
      aggregateValidation(db, r.session(), start + 4),
    );
  } finally {
    db.close();
  }
});

it("keeps first successful duplicate check and all mismatch reasons", () => {
  const db = new BotDatabase(":memory:"),
    monitor = new OperationMonitor(db, 100);
  try {
    const expected = { ...db.portfolio(), gasUsdc: "0", tradeFee: "1" };
    db.append(
      "paper_checks",
      "a",
      {
        ok: false,
        orderId: "order",
        expected: { ...expected, tradeFee: "99" },
      },
      1,
    );
    db.append("paper_checks", "b", { ok: true, orderId: "order", expected }, 2);
    db.append(
      "paper_checks",
      "c",
      { ok: true, orderId: "order", expected: { ...expected, tradeFee: "2" } },
      3,
    );
    db.append(
      "paper_trades",
      "trade",
      { orderId: "order", fee: "1", costs: { gasUsdc: "0" } },
      4,
    );
    expect(monitor.ledger(100).reasons).toEqual(["FILL_LEDGER_COUNT_MISMATCH"]);
    const spy = vi.spyOn(db, "operationCounts");
    monitor.report(24, 100);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});

it("isolates timing contexts and records failed SQL without swallowing errors", async () => {
  const db = new BotDatabase(":memory:");
  try {
    const results = await Promise.all(
      [1, 2].map((n) =>
        withApiTiming(async () => {
          await Promise.resolve();
          timeAggregation(() => {
            for (let i = 0; i < n; i++) db.runtime();
          });
          return { ...currentApiTiming()! };
        }),
      ),
    );
    expect(results.map((r) => r.sqlCount)).toEqual([1, 2]);
    withApiTiming(() => {
      db.append("paper_orders", "duplicate", {}, 1);
      expect(() => db.append("paper_orders", "duplicate", {}, 1)).toThrow();
      expect(currentApiTiming()!.sqlCount).toBe(2);
    });
    expect(currentApiTiming()).toBeUndefined();
  } finally {
    db.close();
  }
});
