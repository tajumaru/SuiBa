import { afterEach, expect, it, vi } from "vitest";
import {
  ApiAccess,
  RateLimited,
  circuitLimits,
} from "../packages/shared/src/api.ts";
import { withReadBudget } from "../packages/shared/src/read-budget-node.ts";

afterEach(() => vi.useRealTimers());
const status = (a: ApiAccess) =>
  a.snapshot().find((x) => x.api === "DeepBook Indexer")!;
async function trip(a: ApiAccess) {
  for (let i = 0; i < 3; i++)
    await expect(
      a.run("DeepBook Indexer", `failure-${i}`, async () => {
        throw new Error("UPSTREAM_BODY_TIMEOUT");
      }),
    ).rejects.toThrow("UPSTREAM_BODY_TIMEOUT");
}

it("isolates APIs and keeps orders blocked until one successful probe", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  await trip(a);
  expect(status(a)).toMatchObject({ circuit: "OPEN", consecutiveFailures: 3 });
  const probe = vi.fn(async () => 42);
  const pending = a.run("DeepBook Indexer", "probe", probe);
  await vi.advanceTimersByTimeAsync(circuitLimits.baseOpenMs - 1);
  expect(probe).not.toHaveBeenCalled();
  expect(a.blocked()).toBe(true);
  expect(await a.run("Sui gRPC", "other", async () => 1)).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBe(42);
  expect(status(a)).toMatchObject({
    circuit: "CLOSED",
    consecutiveFailures: 0,
  });
  expect(a.blocked()).toBe(false);
});

it("admits a single probe before queued keys, without retrying a failed probe", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  await trip(a);
  const probe = vi.fn(async () => {
    throw new Error("UPSTREAM_CONNECT_TIMEOUT");
  });
  const one = expect(
    a.run("DeepBook Indexer", "one", probe, 0, { maxTransientRetries: 2 }),
  ).rejects.toThrow("UPSTREAM_CONNECT_TIMEOUT");
  const queued = vi.fn(async () => 2);
  const two = a.run("DeepBook Indexer", "two", queued);
  await vi.advanceTimersByTimeAsync(30000);
  await one;
  expect(probe).toHaveBeenCalledTimes(1);
  expect(queued).not.toHaveBeenCalled();
  expect(status(a).circuitUntil).toBe(Date.now() + 60000);
  await vi.advanceTimersByTimeAsync(60000);
  expect(await two).toBe(2);
});

it("aborts the open-period wait at the acquisition deadline with no transport call", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess(),
    controller = new AbortController();
  await trip(a);
  const read = vi.fn(async () => 1);
  const pending = withReadBudget(controller.signal, true, () =>
    a.run("DeepBook Indexer", "wait", read),
  );
  const rejected = expect(pending).rejects.toThrow("MARKET_DATA_STALLED");
  controller.abort(new Error("MARKET_DATA_STALLED"));
  await rejected;
  await vi.advanceTimersByTimeAsync(120000);
  expect(read).not.toHaveBeenCalled();
  expect(a.blocked()).toBe(true);
  expect(status(a).active).toBe(false);
});

it("preserves an expired open circuit across restart and manual reset", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  await trip(a);
  await vi.advanceTimersByTimeAsync(30001);
  const b = new ApiAccess();
  b.restoreCooldowns(JSON.parse(JSON.stringify(a.snapshot())));
  b.reset();
  expect(b.blocked()).toBe(true);
  expect(status(b).circuit).toBe("HALF_OPEN");
  const pending = b.run("DeepBook Indexer", "probe", async () => 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(await pending).toBe(1);
  expect(b.blocked()).toBe(false);
});

it("counts bounded retries as failures and clears an earlier cached success", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  await a.run("DeepBook Indexer", "cached", async () => 1, 60000);
  const read = vi.fn(async () => {
    throw new Error("UPSTREAM_BODY_TIMEOUT");
  });
  const pending = expect(
    a.run("DeepBook Indexer", "fail", read, 0, { maxTransientRetries: 2 }),
  ).rejects.toThrow("UPSTREAM_BODY_TIMEOUT");
  await vi.runAllTimersAsync();
  await pending;
  expect(read).toHaveBeenCalledTimes(3);
  expect(status(a).circuit).toBe("OPEN");
  const fresh = vi.fn(async () => 2);
  const recovery = a.run("DeepBook Indexer", "cached", fresh, 60000);
  await vi.advanceTimersByTimeAsync(30000);
  expect(await recovery).toBe(2);
  expect(fresh).toHaveBeenCalledTimes(1);
});

it.each(["INVALID_CANDLE", "UPSTREAM_TLS_FAILED", "API_CANCELLED"])(
  "does not treat %s as a recoverable outage",
  async (code) => {
    const a = new ApiAccess();
    for (let i = 0; i < 4; i++)
      await expect(
        a.run("DeepBook Indexer", "x", async () => {
          throw new Error(code);
        }),
      ).rejects.toThrow(code);
    expect(status(a).circuit).toBe("CLOSED");
  },
);

it("preserves the separate rate-limit stop and long Retry-After", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  a.onRateLimit = vi.fn();
  await expect(
    a.run("DeepBook Indexer", "429", async () => {
      throw new RateLimited("120");
    }),
  ).rejects.toThrow("API_RETRIES_EXHAUSTED");
  expect(a.onRateLimit).toHaveBeenCalledTimes(1);
  expect(status(a)).toMatchObject({
    circuit: "CLOSED",
    exhausted: true,
    nextRetryAt: Date.now() + 120000,
  });
  expect(a.blocked()).toBe(true);
});

it("keeps the breaker closed to orders when saving the recovery result fails", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  await trip(a);
  a.onCircuitChange = () => {
    throw new Error("storage failure");
  };
  const result = expect(
    a.run("DeepBook Indexer", "probe", async () => 1),
  ).rejects.toThrow("VALIDATION_RECORD_FAILED");
  await vi.advanceTimersByTimeAsync(30000);
  await result;
  expect(a.blocked()).toBe(true);
  expect(status(a).circuit).toBe("OPEN");
});

it("survives 48 simulated hours with repeated outages and bounded recent telemetry", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  let outages = 0;
  for (let minute = 0; minute < 48 * 60; minute++) {
    if (minute % 360 === 0) {
      await trip(a);
      outages++;
      expect(a.blocked()).toBe(true);
      const recovery = a.run(
        "DeepBook Indexer",
        "periodic",
        async () => minute,
      );
      await vi.advanceTimersByTimeAsync(30000);
      expect(await recovery).toBe(minute);
    } else {
      expect(
        await a.run("DeepBook Indexer", "periodic", async () => minute),
      ).toBe(minute);
    }
    expect(a.blocked()).toBe(false);
    expect(status(a).requestsPerMinute).toBeLessThanOrEqual(5);
    await vi.advanceTimersByTimeAsync(60000);
  }
  expect(outages).toBe(8);
  expect(status(a).requests).toBe(2880 + 24);
});
