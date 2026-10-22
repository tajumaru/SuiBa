import { afterEach, expect, it, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { recoverableReadFailure } from "../packages/shared/src/paper-recovery.ts";
import type { ApiFailure } from "../packages/shared/src/http-errors.ts";

export const failure = (patch: Partial<ApiFailure> = {}): ApiFailure => ({
  api: "DeepBook Indexer", host: "deepbook-indexer.mainnet.mystenlabs.com",
  url: "https://deepbook-indexer.mainnet.mystenlabs.com/[redacted]",
  operation: "OHLCV_FETCH", method: "GET", code: "UPSTREAM_BODY_TIMEOUT",
  phase: "BODY", timeoutType: "BODY", causeCode: null, status: null,
  elapsedMs: 8000, occurredAt: Date.now(), ...patch,
});
const databases: BotDatabase[] = [];
function setup() {
  const db = new BotDatabase(":memory:"); databases.push(db);
  db.set("runtime", { ...db.runtime(), running: true });
  const monitor = new OperationMonitor(db); monitor.beginCycle();
  return { db, monitor };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("blocks orders on the first evidenced BODY failure without latching a hard error", () => {
  const { db, monitor } = setup(); const f = failure();
  monitor.transientFailure(f.api, f.code, f);
  expect(db.runtime()).toMatchObject({ running: false, error: null });
  expect(monitor.safety()).toMatchObject({ connectivity: "DEGRADED", resumePending: true });
  expect(monitor.ordersAllowed()).toBe(false);
  expect(monitor.transientCycleFailure(f.code)).toBe(true);
});
it("does not infer recoverability from a code or an unrelated API", () => {
  expect(recoverableReadFailure(undefined)).toBe(false);
  expect(recoverableReadFailure(failure({ api: "Cetus" }))).toBe(false);
  expect(recoverableReadFailure(failure({ timeoutType: null }))).toBe(false);
  const { db, monitor } = setup(); monitor.transientFailure("DeepBook Indexer", "UPSTREAM_BODY_TIMEOUT");
  expect(db.runtime().error).toBe("UPSTREAM_BODY_TIMEOUT");
  expect(monitor.safety().resumePending).toBe(false);
});
it("keeps BODY TLS CONNECT failures paused and never permits orders", () => {
  const { db, monitor } = setup();
  for (const f of [failure(), failure({ code: "UPSTREAM_TIMEOUT", phase: "TLS", timeoutType: "TLS" }),
    failure({ code: "UPSTREAM_CONNECT_TIMEOUT", phase: "CONNECT", timeoutType: "CONNECT" })]) {
    monitor.transientFailure(f.api, f.code, f); expect(monitor.ordersAllowed()).toBe(false);
  }
  expect(monitor.safety().failures).toBe(3); expect(db.runtime().error).toBeNull();
});
it("retains hard stops and cancels automatic resumption", () => {
  const { db, monitor } = setup(); const f = failure(); monitor.transientFailure(f.api, f.code, f);
  monitor.failCycle("MARKET_DATA_STALLED");
  expect(db.runtime().error).toBe("MARKET_DATA_STALLED");
  expect(monitor.safety().resumePending).toBe(false);
});
it("never permits LIVE execution", () => {
  const { db } = setup(); const monitor = new OperationMonitor(db, Date.now(), () => performance.now(), "LIVE"); expect(monitor.ordersAllowed()).toBe(false);
});
