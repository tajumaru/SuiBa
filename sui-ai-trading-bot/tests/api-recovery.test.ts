import { afterEach, expect, it, vi } from "vitest";
import { ApiAccess } from "../packages/shared/src/api.ts";
afterEach(() => vi.useRealTimers());
it("stops on the first transient error before bounded recovery, with single flight", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  let stopped = false;
  const stop = vi.fn(() => {
    stopped = true;
  });
  a.onTransientFailure = stop;
  let n = 0;
  const fn = vi.fn(async () => {
    if (n++ < 2) throw Error("UPSTREAM_HTTP_503");
    return 42;
  });
  const p = a.run("DeepBook Indexer", "same", fn, 0, {
    maxTransientRetries: 2,
  });
  const duplicate = a.run("DeepBook Indexer", "same", fn, 0, {
    maxTransientRetries: 2,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(true);
  expect(fn).toHaveBeenCalledTimes(1);
  await vi.runAllTimersAsync();
  expect(await p).toBe(42);
  expect(await duplicate).toBe(42);
  expect(fn).toHaveBeenCalledTimes(3);
  expect(stop).toHaveBeenCalledTimes(2);
  expect(a.snapshot().find((x) => x.api === "DeepBook Indexer")).toMatchObject({
    retries: 2,
    requests: 3,
    failed: false,
  });
  expect(stopped).toBe(true);
});
it("caps transient retries at two even if caller asks for more", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess(),
    fn = vi.fn(async () => {
      throw Error("UPSTREAM_HTTP_502");
    });
  const pending = expect(
    a.run("DeepBook Indexer", "x", fn, 0, { maxTransientRetries: 100 }),
  ).rejects.toThrow("UPSTREAM_HTTP_502");
  await vi.runAllTimersAsync();
  await pending;
  expect(fn).toHaveBeenCalledTimes(3);
});
it("cancels retry wait immediately without another request", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess(),
    fn = vi.fn(async () => {
      throw Error("UPSTREAM_TIMEOUT");
    });
  const pending = expect(
    a.run("DeepBook Indexer", "x", fn, 0, { maxTransientRetries: 2 }),
  ).rejects.toThrow("API_CANCELLED");
  await vi.advanceTimersByTimeAsync(0);
  a.cancel();
  await pending;
  await vi.runAllTimersAsync();
  expect(fn).toHaveBeenCalledTimes(1);
});
it("never retries an ordinary 500 or quality error", async () => {
  for (const code of ["UPSTREAM_HTTP_500", "STALE_CANDLES", "INVALID_CANDLE"]) {
    const a = new ApiAccess(),
      fn = vi.fn(async () => {
        throw Error(code);
      });
    await expect(
      a.run("DeepBook Indexer", code, fn, 0, { maxTransientRetries: 2 }),
    ).rejects.toThrow(code);
    expect(fn).toHaveBeenCalledTimes(1);
  }
});
