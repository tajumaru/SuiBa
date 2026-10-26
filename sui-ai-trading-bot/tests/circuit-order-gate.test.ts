import { afterEach, expect, it, vi } from "vitest";
import { apiAccess } from "../packages/shared/src/api.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
afterEach(() => vi.useRealTimers());

it("blocks orders for an expired breaker and still rejects stale data after a successful probe", async () => {
  vi.useFakeTimers();
  const db = new BotDatabase(":memory:");
  try {
    const monitor = new OperationMonitor(db);
    db.set("runtime", { ...db.runtime(), running: true });
    monitor.market(Date.now(), Date.now());
    expect(monitor.ordersAllowed()).toBe(true);
    for (let i = 0; i < 3; i++)
      await expect(
        apiAccess.run("DeepBook Indexer", "failure", async () => {
          throw new Error("UPSTREAM_BODY_TIMEOUT");
        }),
      ).rejects.toThrow("UPSTREAM_BODY_TIMEOUT");
    expect(monitor.ordersAllowed()).toBe(false);
    await vi.advanceTimersByTimeAsync(180001);
    expect(monitor.ordersAllowed()).toBe(false);
    const pending = apiAccess.run("DeepBook Indexer", "probe", async () => 1);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(apiAccess.blocked()).toBe(false);
    expect(monitor.ordersAllowed()).toBe(false);
    expect(monitor.safetySnapshot().controlState).toBe("PAUSED");
    monitor.market(Date.now(), Date.now());
    expect(monitor.ordersAllowed()).toBe(true);
    monitor.boot();
    expect(monitor.ordersAllowed()).toBe(false);
    expect(db.runtime().running).toBe(false);
  } finally {
    db.close();
  }
});
