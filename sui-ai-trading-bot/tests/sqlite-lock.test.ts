import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { ReadOnlySuiClient } from "../packages/sui-client/src/index.ts";
import { withReadBudget } from "../packages/shared/src/read-budget-node.ts";
import { GrpcTypes } from "@mysten/sui/grpc";
import { lockFixture } from "../scripts/sqlite-lock-fixture.ts";
const cleanup: (() => void | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture() {
  const path = join(
    mkdtempSync(join(tmpdir(), "suiba-lock-test-")),
    "fixture.sqlite",
  );
  const db = new BotDatabase(path),
    raw = new DatabaseSync(path);
  cleanup.push(
    () => db.close(),
    () => raw.close(),
  );
  return { db, raw, path };
}
function response(decimals: number) {
  const message = GrpcTypes.GetCoinInfoResponse.toBinary(
    GrpcTypes.GetCoinInfoResponse.create({ metadata: { decimals } }),
  );
  const frame = (flag: number, data: Uint8Array) => {
    const b = Buffer.alloc(5 + data.length);
    b[0] = flag;
    b.writeUInt32BE(data.length, 1);
    b.set(data, 5);
    return b;
  };
  return new Response(
    Buffer.concat([
      frame(0, message),
      frame(128, Buffer.from("grpc-status: 0\r\n")),
    ]).toString("base64"),
    { headers: { "content-type": "application/grpc-web-text" } },
  );
}
it.each([5, 261, 517, 773])(
  "propagates BUSY code %s without poisoning the connection",
  (errcode) => {
    const { db } = fixture();
    const error = Object.assign(new Error("fixture"), {
      code: "ERR_SQLITE_ERROR",
      errcode,
    });
    const sql = (db as unknown as { sql<T>(fn: () => T): T }).sql.bind(db);
    expect(() =>
      sql(() => {
        throw error;
      }),
    ).toThrow(error);
    expect(db.health()).toMatchObject({
      healthy: true,
      requiresRestart: false,
    });
    db.append("sui_observations", "after-busy", {});
  },
);
it.each([
  6,
  262,
  518,
  11,
  779,
  26,
  10,
  1029,
  "5",
  "SQLITE_BUSY",
  undefined,
  NaN,
])(
  "keeps LOCKED, permanent and unsupported errcode %s fail-closed",
  (errcode) => {
    const { db } = fixture();
    const error = Object.assign(new Error("fixture"), { errcode });
    const sql = (db as unknown as { sql<T>(fn: () => T): T }).sql.bind(db);
    expect(() =>
      sql(() => {
        throw error;
      }),
    ).toThrow(error);
    expect(db.health()).toMatchObject({
      healthy: false,
      requiresRestart: true,
    });
    expect(() => db.append("sui_observations", "after-fault", {})).toThrow(
      "DATABASE_UNAVAILABLE",
    );
    expect(db.runtime().running).toBe(false);
  },
);
it("preserves WAL/FULL, uses no busy waiting, and synchronously acknowledges durable rows", () => {
  const { db, raw } = fixture();
  const connection = (db as unknown as { db: DatabaseSync }).db;
  expect(connection.prepare("PRAGMA busy_timeout").get()).toMatchObject({
    timeout: 0,
  });
  expect(connection.prepare("PRAGMA journal_mode").get()).toMatchObject({
    journal_mode: "wal",
  });
  expect(connection.prepare("PRAGMA synchronous").get()).toMatchObject({
    synchronous: 2,
  });
  db.append("sui_observations", "evidence", { requestId: "fixture" });
  expect(
    raw.prepare("SELECT count(*) n FROM sui_observations").get(),
  ).toMatchObject({ n: 1 });
  expect(db.health().healthy).toBe(true);
});
it.each([200, 10000])(
  "fails closed promptly on a %sms writer lock without implicit retries",
  async (duration) => {
    const { db, raw, path } = fixture();
    db.set("runtime", { ...db.runtime(), running: true });
    const monitor = new OperationMonitor(db);
    const lock = await lockFixture(path, duration);
    cleanup.push(() => lock.terminate());
    const controller = new AbortController();
    const began = performance.now();
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        controller.abort();
        resolve();
      }, 0),
    );
    expect(() => db.append("sui_observations", "locked", {})).toThrow();
    await timer;
    expect(performance.now() - began).toBeLessThan(500);
    expect(controller.signal.aborted).toBe(true);
    expect(db.health()).toMatchObject({
      healthy: true,
      requiresRestart: false,
    });
    expect(monitor.ordersAllowed()).toBe(false);
    await lock.terminate();
    db.append("sui_observations", "retry", { recovered: true });
    expect(db.history("sui_observations")).toEqual([{ recovered: true }]);
    expect(db.history("paper_orders")).toHaveLength(0);
    expect(db.history("paper_trades")).toHaveLength(0);
  },
);
it("latches actual READONLY writes and rejects recovery after the connection becomes writable", () => {
  const { db } = fixture();
  const connection = (db as unknown as { db: DatabaseSync }).db;
  connection.exec("PRAGMA query_only=ON");
  expect(() => db.append("sui_observations", "readonly", {})).toThrow();
  expect(db.health()).toMatchObject({ healthy: false, sqliteCode: 8 });
  connection.exec("PRAGMA query_only=OFF");
  expect(() => db.transaction(() => db.set("runtime", {}))).toThrow(
    "DATABASE_UNAVAILABLE",
  );
});
it("keeps actual same-connection SQLITE_LOCKED fail-closed after cursor cleanup", () => {
  const { db } = fixture();
  const connection = (db as unknown as { db: DatabaseSync }).db;
  db.append("sui_observations", "cursor-row", {});
  const cursor = connection.prepare("SELECT * FROM sui_observations").iterate();
  cursor.next();
  const sql = (db as unknown as { sql<T>(fn: () => T): T }).sql.bind(db);
  try {
    expect(() =>
      sql(() => connection.exec("DROP TABLE sui_observations")),
    ).toThrow(
      expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 6 }),
    );
  } finally {
    cursor.return?.();
  }
  expect(db.health()).toMatchObject({
    healthy: false,
    sqliteCode: 6,
    requiresRestart: true,
  });
  expect(() => db.append("sui_observations", "after-locked", {})).toThrow(
    "DATABASE_UNAVAILABLE",
  );
});
it("rolls back partial evidence/accounting changes on an operational write fault", () => {
  const { db } = fixture();
  const connection = (db as unknown as { db: DatabaseSync }).db;
  const portfolio = db.portfolio();
  expect(() =>
    db.transaction(() => {
      db.append("sui_observations", "uncommitted", {});
      db.set("portfolio", { ...portfolio, usdc: 0 });
      connection.exec("PRAGMA query_only=ON");
      db.append("paper_checks", "failure", {});
    }),
  ).toThrow();
  connection.exec("PRAGMA query_only=OFF");
  expect(db.history("sui_observations")).toHaveLength(0);
  expect(db.portfolio()).toEqual(portfolio);
  expect(db.health().healthy).toBe(false);
  expect(db.history("paper_orders")).toHaveLength(0);
  expect(db.history("paper_trades")).toHaveLength(0);
});
it("constraint rejection rolls back its transaction without poisoning a healthy connection", () => {
  const { db } = fixture();
  db.append("sui_observations", "duplicate", { original: true });
  const portfolio = db.portfolio();
  expect(() =>
    db.transaction(() => {
      db.set("portfolio", { ...portfolio, usdc: 0 });
      db.append("sui_observations", "duplicate", { original: false });
    }),
  ).toThrow();
  expect(db.portfolio()).toEqual(portfolio);
  expect(db.history("sui_observations")).toEqual([{ original: true }]);
  expect(db.health().healthy).toBe(true);
});
it.each([false, true])(
  "Sui evidence BUSY cannot grant health or resume manual stop=%s",
  async (manual) => {
    const { db, raw } = fixture();
    db.set("runtime", { ...db.runtime(), running: !manual });
    const monitor = new OperationMonitor(db);
    if (manual) monitor.transition("MANUAL_STOP");
    let calls = 0,
      writes = 0;
    const client = new ReadOnlySuiClient(undefined, {
      fetch: async () => response(calls++ % 2 ? 6 : 9),
      onObservation: (event) => {
        writes++;
        db.append("sui_observations", String(writes), event, event.at);
      },
    });
    cleanup.push(() => client.close());
    raw.exec("BEGIN IMMEDIATE");
    await expect(client.health(true)).rejects.toThrow(
      "VALIDATION_RECORD_FAILED",
    );
    expect(writes).toBe(1);
    expect(client.status.healthy).toBe(false);
    expect(db.health().requiresRestart).toBe(false);
    expect(monitor.ordersAllowed()).toBe(false);
    raw.exec("ROLLBACK");
    for (let n = 0; n < 3; n++) {
      await expect(client.health(true)).rejects.toThrow(
        "VALIDATION_RECORD_FAILED",
      );
      expect(monitor.recoveryCycle({ market: true, sui: true })).toBe(false);
    }
    expect(writes).toBe(1);
    expect(db.history("paper_orders")).toHaveLength(0);
    expect(db.history("paper_trades")).toHaveLength(0);
  },
);
it("cancellation during synchronous evidence persistence cannot establish health", async () => {
  const { db } = fixture();
  const controller = new AbortController();
  let n = 0;
  const client = new ReadOnlySuiClient(undefined, {
    fetch: async () => response(n++ % 2 ? 6 : 9),
    onObservation: (event) => {
      db.append("sui_observations", String(n) + event.layer, event, event.at);
      if (event.layer === "HTTP")
        controller.abort(Error("MARKET_DATA_STALLED"));
    },
  });
  cleanup.push(() => client.close());
  await expect(
    withReadBudget(controller.signal, true, () => client.health(true)),
  ).rejects.toThrow();
  expect(client.status.healthy).toBe(false);
  expect(db.history("paper_orders")).toHaveLength(0);
  expect(db.history("paper_trades")).toHaveLength(0);
});

it("rolls back a failed COMMIT before acknowledging accounting or evidence", () => {
  const { db, raw } = fixture();
  const portfolio = db.portfolio();
  const connection = (db as unknown as { db: DatabaseSync }).db;
  const exec = connection.exec.bind(connection);
  connection.exec = (sql: string) => {
    if (sql === "COMMIT")
      throw Object.assign(Error("fixture I/O failure"), { errcode: 10 });
    return exec(sql);
  };
  expect(() =>
    db.transaction(() => {
      db.append("sui_observations", "commit-pending", {});
      db.set("portfolio", { ...portfolio, usdc: 0 });
    }),
  ).toThrow("fixture I/O failure");
  expect(db.health()).toMatchObject({ healthy: false, sqliteCode: 10 });
  expect(db.portfolio()).toEqual(portfolio);
  expect(
    raw.prepare("SELECT count(*) n FROM sui_observations").get(),
  ).toMatchObject({ n: 0 });
});

it("a new process connection still applies boot stop instead of resuming persisted intent", () => {
  const { db, raw, path } = fixture();
  db.set("runtime", { ...db.runtime(), running: true });
  raw.exec("BEGIN IMMEDIATE");
  expect(() =>
    db.set("runtime", { ...db.runtime(), running: false }),
  ).toThrow();
  expect(db.health().requiresRestart).toBe(false);
  raw.exec("ROLLBACK");
  const restarted = new BotDatabase(path);
  cleanup.push(() => restarted.close());
  const monitor = new OperationMonitor(restarted);
  monitor.boot();
  expect(restarted.runtime().running).toBe(false);
  expect(monitor.ordersAllowed()).toBe(false);
  expect(monitor.safety().resumePending).toBe(false);
  expect(restarted.history("paper_orders")).toHaveLength(0);
  expect(restarted.history("paper_trades")).toHaveLength(0);
});
