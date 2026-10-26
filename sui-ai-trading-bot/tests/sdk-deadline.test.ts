import { afterEach, expect, it, vi } from "vitest";
import {
  sdkRequests,
  sdkRequestLimits,
} from "../packages/shared/src/sdk-requests.ts";
import { currentReadBudget } from "../packages/shared/src/read-budget.ts";
import { withReadBudget } from "../packages/shared/src/read-budget-node.ts";
afterEach(() => vi.useRealTimers());

it("bounds the whole SDK call even if the SDK swallows or never returns an HTTP error", async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const pending = expect(
    sdkRequests(async () => {
      signal = currentReadBudget()!.signal;
      return new Promise(() => {});
    }),
  ).rejects.toThrow("UPSTREAM_TIMEOUT");
  await vi.advanceTimersByTimeAsync(sdkRequestLimits.deadlineMs);
  await pending;
  expect(signal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves a shorter acquisition deadline and its cycle identity", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const pending = expect(
    withReadBudget(
      controller.signal,
      true,
      () =>
        sdkRequests(async () => {
          expect(currentReadBudget()).toMatchObject({
            fresh: true,
            cycleId: "parent",
          });
          return new Promise(() => {});
        }),
      "parent",
    ),
  ).rejects.toThrow("MARKET_DATA_STALLED");
  controller.abort(new Error("MARKET_DATA_STALLED"));
  await pending;
  expect(vi.getTimerCount()).toBe(0);
});
it("cleans the deadline after success or a synchronous SDK exception", async () => {
  vi.useFakeTimers();
  expect(await sdkRequests(async () => 3)).toBe(3);
  await expect(
    sdkRequests(() => {
      throw new Error("SDK_FAILURE");
    }),
  ).rejects.toThrow("SDK_FAILURE");
  expect(vi.getTimerCount()).toBe(0);
});
