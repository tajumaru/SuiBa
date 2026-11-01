import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { recoverableReadFailure } from "../packages/shared/src/paper-recovery.ts";
import type { ApiFailure } from "../packages/shared/src/http-errors.ts";

export const failure = (patch: Partial<ApiFailure> = {}): ApiFailure => ({
  api: "DeepBook Indexer",
  host: "deepbook-indexer.mainnet.mystenlabs.com",
  url: "https://deepbook-indexer.mainnet.mystenlabs.com/[redacted]",
  operation: "OHLCV_FETCH",
  method: "GET",
  code: "UPSTREAM_BODY_TIMEOUT",
  phase: "BODY",
  timeoutType: "BODY",
  causeCode: null,
  status: null,
  elapsedMs: 8000,
  occurredAt: Date.now(),
  ...patch,
});
const databases: BotDatabase[] = [];
const folders: string[] = [];
function setup() {
  const db = new BotDatabase(":memory:");
  databases.push(db);
  db.set("runtime", { ...db.runtime(), running: true });
  const monitor = new OperationMonitor(db);
  monitor.beginCycle();
  return { db, monitor };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["BUY", "SELL"] as const)(
  "isolates recovery direction validation for a %s order",
  (side) => {
    for (const mismatch of [false, true]) {
      const { db, monitor } = setup(),
        start = Date.now();
      const id = "direction-only";
      db.append("paper_orders", id, { id, status: "FILLED", side }, start);
      db.append(
        "paper_trades",
        id,
        {
          orderId: id,
          side: mismatch ? (side === "BUY" ? "SELL" : "BUY") : side,
          fee: "0",
          costs: { gasUsdc: "0" },
        },
        start,
      );
      db.append(
        "paper_checks",
        id,
        {
          orderId: id,
          ok: true,
          expected: { ...db.portfolio(), gasUsdc: "0", tradeFee: "0" },
        },
        start,
      );
      expect(monitor.ledger().ok).toBe(true);
      const f = failure({ occurredAt: start });
      monitor.transientFailure(f.api, f.code, f, start);
      monitor.market(start, start);
      monitor.beginCycle();
      expect(
        monitor.recoveryCycle({ market: true, sui: true }, start + 1000),
      ).toBe(false);
      if (mismatch) {
        expect(db.runtime().error).toBe("PAPER_ORDER_STATE_UNKNOWN");
        expect(monitor.safety().resumePending).toBe(false);
      } else expect(db.runtime().error).toBeNull();
      monitor.beginCycle();
      expect(
        monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
      ).toBe(!mismatch);
      expect(db.runtime().running).toBe(!mismatch);
      if (mismatch) expect(monitor.ordersAllowed()).toBe(false);
    }
  },
);

it("closes the recovery gate on a separate SQLite writer lock", () => {
  const folder = mkdtempSync(join(tmpdir(), "suiba-recovery-lock-"));
  folders.push(folder);
  const path = join(folder, "bot.sqlite"),
    db = new BotDatabase(path);
  databases.push(db);
  db.set("runtime", { ...db.runtime(), running: true });
  const monitor = new OperationMonitor(db),
    start = Date.now();
  const f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  const writer = new DatabaseSync(path);
  try {
    writer.exec("BEGIN IMMEDIATE");
    expect(
      monitor.recoveryCycle({ market: true, sui: true }, start + 1000),
    ).toBe(false);
    expect(monitor.ordersAllowed()).toBe(false);
    expect(db.runtime().running).toBe(false);
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
  // Even though both proof and stop persistence encountered BUSY, releasing the lock cannot reopen the gate.
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
  ).toBe(false);
  expect(monitor.ordersAllowed()).toBe(false);
});

it("rolls back a real deferred-constraint COMMIT failure during resume", () => {
  const { db, monitor } = setup(),
    start = Date.now();
  const f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  monitor.recoveryCycle({ market: true, sui: true }, start + 1000);
  const raw = (db as unknown as { db: DatabaseSync }).db;
  raw.exec(`
    CREATE TABLE commit_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE commit_child(parent INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_resume_commit AFTER UPDATE ON bot_runtime_state
    WHEN NEW.key='runtime' AND json_extract(NEW.json,'$.running')=1
    BEGIN INSERT INTO commit_child VALUES(99); END;
  `);
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
  ).toBe(false);
  expect(raw.prepare("SELECT * FROM commit_child").all()).toHaveLength(0);
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "PAPER_RECOVERY_READ_FAILED",
  });
  expect(monitor.safety().resumePending).toBe(false);
  expect(
    db
      .history("operation_events")
      .some((e) => e.reason === "PAPER_NETWORK_RECOVERED"),
  ).toBe(false);
  expect(monitor.ordersAllowed()).toBe(false);
});

it("blocks orders on the first evidenced BODY failure without latching a hard error", () => {
  const { db, monitor } = setup();
  const f = failure();
  monitor.transientFailure(f.api, f.code, f);
  expect(db.runtime()).toMatchObject({ running: false, error: null });
  expect(monitor.safety()).toMatchObject({
    connectivity: "DEGRADED",
    resumePending: true,
  });
  expect(monitor.ordersAllowed()).toBe(false);
  expect(monitor.transientCycleFailure(f.code)).toBe(true);
});
it("treats evidenced GeckoTerminal transport failures as recoverable, host-checked", () => {
  const gecko = failure({
    api: "GeckoTerminal",
    host: "api.geckoterminal.com",
    url: "https://api.geckoterminal.com/[redacted]",
  });
  expect(recoverableReadFailure(gecko)).toBe(true);
  expect(recoverableReadFailure({ ...gecko, host: "example.com" })).toBe(
    false,
  );
  const { db, monitor } = setup();
  monitor.transientFailure(gecko.api, gecko.code, gecko);
  expect(db.runtime()).toMatchObject({ running: false, error: null });
  expect(monitor.safety()).toMatchObject({
    connectivity: "DEGRADED",
    resumePending: true,
  });
});
it("pauses on a market-data stall and resumes after fresh data passes the proofs", () => {
  const { db, monitor } = setup(),
    start = Date.now();
  monitor.market(start, start);
  monitor.watchdog(start + 361000);
  expect(db.runtime()).toMatchObject({ running: false, error: null });
  expect(monitor.safety()).toMatchObject({
    connectivity: "DEGRADED",
    resumePending: true,
  });
  expect(monitor.ordersAllowed()).toBe(false);
  monitor.market(start + 361000, start + 361000);
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 362000),
  ).toBe(false);
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 361000 + 61000),
  ).toBe(true);
  expect(monitor.safety().connectivity).toBe("HEALTHY");
  expect(db.runtime().running).toBe(true);
});
it("escalates a stall that persists past the episode deadline to a hard stop", () => {
  const { db, monitor } = setup(),
    start = Date.now();
  monitor.market(start, start);
  monitor.watchdog(start + 361000);
  expect(monitor.safety().resumePending).toBe(true);
  monitor.watchdog(start + 361000 + 181000);
  expect(db.runtime().error).toBe("PAPER_RECOVERY_EXHAUSTED");
  expect(monitor.safety().resumePending).toBe(false);
});
it("never softens an existing hard stop into a stall pause", () => {
  const { db, monitor } = setup(),
    start = Date.now();
  monitor.market(start, start);
  monitor.stop("CONSECUTIVE_API_ERRORS", start);
  monitor.watchdog(start + 361000);
  expect(db.runtime().error).toBe("CONSECUTIVE_API_ERRORS");
  expect(monitor.safety()).toMatchObject({
    connectivity: "HEALTHY",
    resumePending: false,
  });
});
it("does not infer recoverability from a code or an unrelated API", () => {
  expect(recoverableReadFailure(undefined)).toBe(false);
  expect(recoverableReadFailure(failure({ api: "Cetus" }))).toBe(false);
  expect(recoverableReadFailure(failure({ timeoutType: null }))).toBe(false);
  const { db, monitor } = setup();
  monitor.transientFailure("DeepBook Indexer", "UPSTREAM_BODY_TIMEOUT");
  expect(db.runtime().error).toBe("UPSTREAM_BODY_TIMEOUT");
  expect(monitor.safety().resumePending).toBe(false);
});
it("keeps BODY TLS CONNECT failures paused and never permits orders", () => {
  const { db, monitor } = setup();
  for (const f of [
    failure(),
    failure({ code: "UPSTREAM_TIMEOUT", phase: "TLS", timeoutType: "TLS" }),
    failure({
      code: "UPSTREAM_CONNECT_TIMEOUT",
      phase: "CONNECT",
      timeoutType: "CONNECT",
    }),
  ]) {
    monitor.transientFailure(f.api, f.code, f);
    expect(monitor.ordersAllowed()).toBe(false);
  }
  expect(monitor.safety().failures).toBe(3);
  expect(db.runtime().error).toBeNull();
});
it("retains hard stops and cancels automatic resumption", () => {
  const { db, monitor } = setup();
  const f = failure();
  monitor.transientFailure(f.api, f.code, f);
  monitor.failCycle("MARKET_DATA_STALLED");
  expect(db.runtime().error).toBe("MARKET_DATA_STALLED");
  expect(monitor.safety().resumePending).toBe(false);
});
it("never permits LIVE execution", () => {
  const { db } = setup();
  const monitor = new OperationMonitor(
    db,
    Date.now(),
    () => performance.now(),
    "LIVE",
  );
  expect(monitor.ordersAllowed()).toBe(false);
});

it("requires independent clean cycles and a full minute before PAPER recovery", () => {
  const { db, monitor } = setup();
  const start = Date.now();
  const f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  expect(monitor.recoveryCycle({ market: true, sui: true }, start)).toBe(false);
  monitor.beginCycle();
  expect(monitor.recoveryCycle({ market: true, sui: true }, start + 1000)).toBe(
    false,
  );
  expect(monitor.safety().connectivity).toBe("RECOVERING");
  expect(db.runtime().running).toBe(false);
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 31000),
  ).toBe(false);
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
  ).toBe(true);
  expect(db.runtime().running).toBe(true);
  expect(monitor.safety().recoveredAt).toBe(start + 61000);
});

it.each(["MANUAL_STOP", "MANUAL_RESET", "EMERGENCY_STOP", "PROCESS_SHUTDOWN"])(
  "never resumes after %s",
  (reason) => {
    const { db, monitor } = setup();
    const start = Date.now();
    const f = failure();
    monitor.transientFailure(f.api, f.code, f);
    monitor.market(start, start);
    if (reason === "EMERGENCY_STOP")
      db.set("runtime", { ...db.runtime(), emergency: true });
    monitor.transition(reason);
    monitor.beginCycle();
    monitor.recoveryCycle({ market: true, sui: true }, start + 1000);
    monitor.beginCycle();
    monitor.recoveryCycle({ market: true, sui: true }, start + 61000);
    expect(db.runtime().running).toBe(false);
    expect(monitor.safety().recoveredAt).toBeNull();
  },
);

it("diagnostic reads cannot finish recovery or restore an automatic start cancelled during recovery", () => {
  const { db, monitor } = setup(),
    start = Date.now(),
    f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  monitor.recoveryCycle({ market: true, sui: true }, start + 1000);
  expect(monitor.safety()).toMatchObject({
    connectivity: "RECOVERING",
    healthyCycles: 1,
    resumePending: true,
  });

  // Opening diagnostics after the minimum healthy interval is not a fresh
  // market/Sui acquisition and must not manufacture the second clean cycle.
  const before = monitor.safety();
  for (const at of [start + 61000, start + 62000, start + 63000]) {
    expect(monitor.snapshot(at).safety.ordersAllowed).toBe(false);
    expect(monitor.safety()).toEqual(before);
  }
  expect(db.runtime().running).toBe(false);

  monitor.transition("MANUAL_STOP", start + 64000);
  expect(monitor.safety()).toMatchObject({
    connectivity: "RECOVERING",
    healthyCycles: 0,
    resumePending: false,
  });
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 65000),
  ).toBe(false);
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 125000),
  ).toBe(false);
  expect(monitor.safety()).toMatchObject({
    connectivity: "HEALTHY",
    resumePending: false,
    recoveredAt: null,
  });
  expect(monitor.snapshot(start + 125000).safety.botState).toBe("MANUAL_STOP");
  expect(db.runtime().running).toBe(false);
  expect(monitor.ordersAllowed()).toBe(false);
  expect(
    db
      .history<{ code: string }>("operation_events")
      .some((event) => event.code === "PAPER_NETWORK_RECOVERED"),
  ).toBe(false);
  expect(db.history("paper_orders")).toHaveLength(0);
  expect(db.history("paper_trades")).toHaveLength(0);
});

it("restarts recovery progress after another failure and hard-stops a long episode", () => {
  const { db, monitor } = setup();
  const start = Date.now();
  const f = failure();
  monitor.transientFailure(f.api, f.code, f);
  monitor.market(start, start);
  monitor.beginCycle();
  monitor.recoveryCycle({ market: true, sui: true }, start + 1000);
  const next = failure({ occurredAt: start + 30000 });
  monitor.transientFailure(next.api, next.code, next, start + 30000);
  expect(monitor.safety().healthyCycles).toBe(0);
  monitor.checkRecoveryDeadline(start + 180000);
  expect(db.runtime().error).toBe("PAPER_RECOVERY_EXHAUSTED");
});

it("requires market and Sui proofs and refuses corrupted balances", () => {
  const { db, monitor } = setup();
  const f = failure();
  monitor.transientFailure(f.api, f.code, f);
  monitor.beginCycle();
  expect(monitor.recoveryCycle({ market: false, sui: true })).toBe(false);
  expect(monitor.recoveryCycle({ market: true, sui: false })).toBe(false);
  db.set("portfolio", { ...db.portfolio(), usdc: -1 });
  monitor.recoveryCycle({ market: true, sui: true });
  expect(db.runtime().error).toBe("PAPER_RECONCILIATION_FAILED");
});

it("counts a completed cycle only once and caps repeated failures", () => {
  const { db, monitor } = setup();
  const start = Date.now();
  const f = failure();
  monitor.transientFailure(f.api, f.code, f);
  monitor.market(start, start);
  monitor.beginCycle();
  monitor.recoveryCycle({ market: true, sui: true }, start + 1000);
  monitor.recoveryCycle({ market: true, sui: true }, start + 61000);
  expect(monitor.safety().healthyCycles).toBe(1);
  expect(db.runtime().running).toBe(false);
  for (let i = 1; i < 9; i++) monitor.transientFailure(f.api, f.code, f);
  expect(db.runtime().error).toBe("PAPER_RECOVERY_EXHAUSTED");
});

it.each(["PENDING", "UNKNOWN", "FILLED", "CANCELLED"])(
  "requires review for unresolved %s orders",
  (status) => {
    const { db, monitor } = setup();
    const start = Date.now();
    const f = failure({ occurredAt: start });
    monitor.transientFailure(f.api, f.code, f, start);
    db.append("paper_orders", "orphan", { id: "orphan", status }, start);
    monitor.market(start, start);
    monitor.beginCycle();
    expect(
      monitor.recoveryCycle({ market: true, sui: true }, start + 1000),
    ).toBe(false);
    expect(db.runtime()).toMatchObject({
      running: false,
      error: "PAPER_ORDER_STATE_UNKNOWN",
    });
    expect(monitor.safety().resumePending).toBe(false);
    monitor.beginCycle();
    expect(
      monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
    ).toBe(false);
    expect(monitor.ordersAllowed()).toBe(false);
  },
);

it("requires consecutive healthy proofs after a missing market or Sui proof", () => {
  const { db, monitor } = setup();
  const start = Date.now(),
    f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  monitor.recoveryCycle({ market: true, sui: true }, start + 1000);
  expect(monitor.safety().healthyCycles).toBe(1);
  monitor.beginCycle();
  monitor.recoveryCycle({ market: false, sui: true }, start + 31000);
  expect(monitor.safety()).toMatchObject({
    connectivity: "DEGRADED",
    healthyCycles: 0,
    firstHealthyAt: null,
  });
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
  ).toBe(false);
  expect(db.runtime().running).toBe(false);
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 121000),
  ).toBe(true);
});

it.each([
  "duplicate-order-id",
  "orphan-trade",
  "orphan-check",
  "failed-check",
  "duplicate-trade",
  "duplicate-check",
  "wrong-side",
  "future-order",
  "invalid-state",
])("refuses automatic restart for %s", (kind) => {
  const { db, monitor } = setup(),
    start = Date.now(),
    f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  const order = { id: "known", status: "FILLED", side: "BUY" };
  db.append("paper_orders", "known", order, start);
  db.append("paper_trades", "known", { orderId: "known", side: "BUY" }, start);
  db.append("paper_checks", "known", { orderId: "known", ok: true }, start);
  if (kind === "duplicate-order-id")
    db.append("paper_orders", "alias", order, start);
  if (kind === "orphan-trade")
    db.append(
      "paper_trades",
      "orphan",
      { orderId: "orphan", side: "BUY" },
      start,
    );
  if (kind === "orphan-check")
    db.append("paper_checks", "orphan", { orderId: "orphan", ok: true }, start);
  if (kind === "failed-check")
    db.append("paper_checks", "failed", { orderId: "known", ok: false }, start);
  if (kind === "duplicate-trade")
    db.append(
      "paper_trades",
      "alias",
      { orderId: "known", side: "BUY" },
      start,
    );
  if (kind === "duplicate-check")
    db.append("paper_checks", "alias", { orderId: "known", ok: true }, start);
  if (kind === "wrong-side") {
    db.append(
      "paper_orders",
      "wrong",
      { id: "wrong", status: "FILLED", side: "SELL" },
      start,
    );
    db.append(
      "paper_trades",
      "wrong",
      { orderId: "wrong", side: "BUY" },
      start,
    );
  }
  if (kind === "future-order")
    db.append(
      "paper_orders",
      "future",
      { id: "future", status: "REJECTED" },
      start + 999999,
    );
  if (kind === "invalid-state")
    db.append(
      "paper_orders",
      "invalid",
      { id: "invalid", status: "BOGUS" },
      start,
    );
  monitor.market(start, start);
  monitor.beginCycle();
  expect(monitor.recoveryCycle({ market: true, sui: true }, start + 1000)).toBe(
    false,
  );
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "PAPER_ORDER_STATE_UNKNOWN",
  });
  expect(monitor.safety().resumePending).toBe(false);
});

it("latches a recovery read exception even when persisting the stop also fails", () => {
  const { db, monitor } = setup(),
    start = Date.now(),
    f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  vi.spyOn(db, "visitRecoveryRecords").mockImplementation(() => {
    throw new Error("read failed");
  });
  const write = vi.spyOn(db, "set").mockImplementation(() => {
    throw new Error("write failed");
  });
  expect(monitor.recoveryCycle({ market: true, sui: true }, start + 1000)).toBe(
    false,
  );
  write.mockRestore();
  db.set("runtime", { ...db.runtime(), running: true });
  expect(monitor.ordersAllowed()).toBe(false);
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
  ).toBe(false);
});

it("durably stops on a ledger read exception", () => {
  const { db, monitor } = setup(),
    start = Date.now(),
    f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  vi.spyOn(db, "range").mockImplementation(() => {
    throw new Error("read failed");
  });
  expect(monitor.recoveryCycle({ market: true, sui: true }, start + 1000)).toBe(
    false,
  );
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "PAPER_RECOVERY_READ_FAILED",
  });
  expect(monitor.safety().resumePending).toBe(false);
});

it("detects an anomaly inserted immediately before the resume proof", () => {
  const { db, monitor } = setup(),
    start = Date.now(),
    f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  monitor.recoveryCycle({ market: true, sui: true }, start + 1000);
  db.append(
    "paper_checks",
    "late",
    { orderId: "late", ok: true },
    start + 60000,
  );
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
  ).toBe(false);
  expect(monitor.ordersAllowed()).toBe(false);
});

it("rechecks a control change during the final ledger proof", () => {
  const { db, monitor } = setup(),
    start = Date.now(),
    f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  monitor.recoveryCycle({ market: true, sui: true }, start + 1000);
  const ledger = monitor.ledger.bind(monitor);
  vi.spyOn(monitor, "ledger").mockImplementation(() => {
    const result = ledger();
    monitor.transition("MANUAL_STOP", start + 61000);
    return result;
  });
  monitor.beginCycle();
  expect(
    monitor.recoveryCycle({ market: true, sui: true }, start + 61000),
  ).toBe(false);
  expect(db.runtime().running).toBe(false);
});

it("scans all 30,000 records without sorting or skipping old history", () => {
  const { db, monitor } = setup();
  db.transaction(() => {
    for (let i = 0; i < 10000; i++) {
      const id = `bulk:${i}`;
      db.append("paper_orders", id, { id, status: "FILLED", side: "BUY" }, i);
      db.append("paper_trades", id, { orderId: id, side: "BUY" }, i);
      db.append("paper_checks", id, { orderId: id, ok: true }, i);
    }
  });
  const scan = (
    monitor as unknown as { recoveryOrdersKnown(now: number): boolean }
  ).recoveryOrdersKnown.bind(monitor);
  expect(scan(Date.now())).toBe(true);
  db.append("paper_trades", "old-orphan", { orderId: "old-orphan" }, 0);
  expect(scan(Date.now())).toBe(false);
});

it("fails closed on an actual SQLite read error", () => {
  const { db, monitor } = setup(),
    start = Date.now(),
    f = failure({ occurredAt: start });
  monitor.transientFailure(f.api, f.code, f, start);
  monitor.market(start, start);
  monitor.beginCycle();
  const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  raw.exec("DROP TABLE paper_orders");
  expect(monitor.recoveryCycle({ market: true, sui: true }, start + 1000)).toBe(
    false,
  );
  expect(db.health().healthy).toBe(false);
  expect(db.runtime().running).toBe(false);
  expect(monitor.ordersAllowed()).toBe(false);
});

it("includes negative rowids and rowid gaps in the full scan", () => {
  const { db, monitor } = setup();
  const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  raw
    .prepare(
      "INSERT INTO paper_orders(rowid,id,timestamp,json) VALUES(?,?,?,?)",
    )
    .run(
      -5,
      "negative",
      0,
      JSON.stringify({ id: "negative", status: "UNKNOWN" }),
    );
  raw
    .prepare(
      "INSERT INTO paper_orders(rowid,id,timestamp,json) VALUES(?,?,?,?)",
    )
    .run(100000, "gap", 0, JSON.stringify({ id: "gap", status: "REJECTED" }));
  expect(
    (
      monitor as unknown as { recoveryOrdersKnown(now: number): boolean }
    ).recoveryOrdersKnown(Date.now()),
  ).toBe(false);
});
