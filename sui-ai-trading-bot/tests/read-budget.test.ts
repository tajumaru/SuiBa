import { expect, it } from "vitest";
import { ApiAccess } from "../packages/shared/src/api.ts";
import { withReadBudget } from "../packages/shared/src/read-budget-node.ts";

it("bypasses cached successes during a fresh recovery acquisition", async () => {
  const a = new ApiAccess();
  let calls = 0;
  const read = () => a.run("read", "x", async () => ++calls, 60000);
  expect(await read()).toBe(1);
  expect(await read()).toBe(1);
  expect(await withReadBudget(new AbortController().signal, true, read)).toBe(
    2,
  );
});
it("aborts an active read at the total deadline", async () => {
  const a = new ApiAccess(),
    c = new AbortController();
  let ended = false;
  let failures = 0;
  a.onAttempt = (e) => {
    if (!e.success) failures++;
  };
  const pending = withReadBudget(c.signal, true, () =>
    a.run(
      "read",
      "x",
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              ended = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
    ),
  );
  await Promise.resolve();
  c.abort(new Error("MARKET_DATA_STALLED"));
  await expect(pending).rejects.toThrow("MARKET_DATA_STALLED");
  expect(ended).toBe(true);
  expect(failures).toBe(1);
  expect(a.snapshot().find((v) => v.api === "read")?.active).toBe(false);
});
it("aborts retry waiting without starting another attempt", async () => {
  const a = new ApiAccess(),
    c = new AbortController();
  let calls = 0;
  const pending = withReadBudget(c.signal, false, () =>
    a.run(
      "read",
      "x",
      async () => {
        calls++;
        throw new Error("UPSTREAM_TIMEOUT");
      },
      0,
      { maxTransientRetries: 2 },
    ),
  );
  await new Promise((r) => setTimeout(r, 10));
  c.abort(new Error("MARKET_DATA_STALLED"));
  await expect(pending).rejects.toThrow();
  expect(calls).toBe(1);
});
it("cancels queued work without aborting the independent active request", async () => {
  const a = new ApiAccess(),
    c = new AbortController();
  let release!: () => void,
    calls = 0;
  const active = a.run(
    "read",
    "first",
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  await Promise.resolve();
  const queued = withReadBudget(c.signal, false, () =>
    a.run("read", "second", async () => ++calls),
  );
  c.abort(new Error("MARKET_DATA_STALLED"));
  await expect(queued).rejects.toThrow("MARKET_DATA_STALLED");
  expect(calls).toBe(0);
  const next = a.run("read", "third", async () => ++calls);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toBe(0);
  release();
  await active;
  await next;
  expect(calls).toBe(1);
});

it("total budget cancels 429 backoff without waiting for the server cooldown", async () => {
  const { RateLimited } = await import("../packages/shared/src/api.ts");
  const a = new ApiAccess(),
    c = new AbortController();
  let calls = 0;
  const pending = withReadBudget(c.signal, false, () =>
    a.run("429-budget", "x", async () => {
      calls++;
      throw new RateLimited("30");
    }),
  );
  const outcome = pending.catch((e) => e.message);
  await new Promise((r) => setTimeout(r, 10));
  c.abort(new Error("MARKET_DATA_STALLED"));
  const result = await Promise.race([
    outcome,
    new Promise((r) => setTimeout(() => r("STILL_WAITING"), 30)),
  ]);
  a.cancel();
  await outcome;
  expect(result).toBe("MARKET_DATA_STALLED");
  expect(calls).toBe(1);
  expect(a.blocked()).toBe(true);
});
it("fresh recovery does not reuse an earlier in-flight success", async () => {
  const a = new ApiAccess();
  let release!: (value: number) => void,
    calls = 0;
  const first = a.run("fresh-flight", "x", () => {
    calls++;
    return new Promise<number>((r) => (release = r));
  });
  const recovery = withReadBudget(new AbortController().signal, true, () =>
    a.run("fresh-flight", "x", async () => ++calls),
  );
  release(1);
  expect(await first).toBe(1);
  expect(await recovery).toBe(2);
  expect(calls).toBe(2);
});
it("does not record a late successful read after its budget expired", async () => {
  const a = new ApiAccess(),
    c = new AbortController();
  let release!: () => void;
  const events: boolean[] = [];
  a.onAttempt = (e) => {
    events.push(e.success);
  };
  const pending = withReadBudget(c.signal, false, () =>
    a.run("late", "x", () => new Promise<void>((r) => (release = r)), 60000),
  );
  const outcome = pending.catch((e) => e.message);
  c.abort(new Error("MARKET_DATA_STALLED"));
  release();
  expect(await outcome).toBe("MARKET_DATA_STALLED");
  expect(events).toEqual([false]);
});
