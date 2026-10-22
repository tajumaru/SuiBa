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
