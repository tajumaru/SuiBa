import { afterEach, expect, it, vi } from "vitest";
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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
