import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  ApiAccess,
  RateLimited,
  retryAfter,
  retryDelay,
  apiFetch,
  apiAccess,
  apiLimits,
} from "../packages/shared/src/api.ts";
import { sdkRequests } from "../packages/shared/src/sdk-requests.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
afterEach(() => vi.useRealTimers());
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
it("parses seconds, HTTP dates, past dates and malformed Retry-After", () => {
  expect(retryAfter("12")).toBe(12000);
  expect(
    retryAfter("Wed, 21 Oct 2026 00:01:00 GMT", Date.UTC(2026, 9, 21)),
  ).toBe(60000);
  expect(
    retryAfter("Wed, 21 Oct 2026 00:01:00 GMT", Date.UTC(2026, 9, 22)),
  ).toBe(0);
  expect(retryAfter("bad")).toBeNull();
  expect(retryAfter("-1")).toBeNull();
  expect(retryAfter(null)).toBeNull();
});
it("uses exponential backoff, positive bounded jitter and a 60-second cap", () => {
  expect(retryDelay(0, null, 0)).toBe(1000);
  expect(retryDelay(1, null, 0)).toBe(2000);
  expect(retryDelay(2, null, 1)).toBe(5000);
  expect(retryDelay(99, null, 1)).toBe(60000);
  expect(retryDelay(0, 5000, 1)).toBe(6000);
});
it("aggregates identical concurrent requests and expires short cache", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  const fn = vi.fn(async () => 42);
  expect(
    await Promise.all([
      a.run("GeckoTerminal", "x", fn, 20000),
      a.run("GeckoTerminal", "x", fn, 20000),
    ]),
  ).toEqual([42, 42]);
  await a.run("GeckoTerminal", "x", fn, 20000);
  expect(fn).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20001);
  await a.run("GeckoTerminal", "x", fn, 20000);
  expect(fn).toHaveBeenCalledTimes(2);
});
it("serializes different requests within one API but allows other APIs", async () => {
  const a = new ApiAccess();
  let release!: () => void;
  const first = a.run(
    "GeckoTerminal",
    "x",
    () => new Promise<void>((r) => (release = r)),
  );
  const fn = vi.fn(async () => 2);
  const next = a.run("GeckoTerminal", "y", fn);
  await flush();
  expect(fn).not.toHaveBeenCalled();
  expect(await a.run("Cetus", "z", async () => 3)).toBe(3);
  release();
  await first;
  await next;
  expect(fn).toHaveBeenCalledTimes(1);
});
it("limits retries to two and requires explicit reset after exhaustion", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  const fn = vi.fn(async () => {
    throw new RateLimited();
  });
  const pending = expect(a.run("GeckoTerminal", "x", fn)).rejects.toThrow(
    "API_RETRIES_EXHAUSTED",
  );
  await vi.runAllTimersAsync();
  await pending;
  expect(fn).toHaveBeenCalledTimes(3);
  expect(a.snapshot()[1]).toMatchObject({
    requests: 3,
    rateLimits: 3,
    retries: 2,
    exhausted: true,
  });
  await expect(a.run("GeckoTerminal", "y", fn)).rejects.toThrow(
    "API_RETRIES_EXHAUSTED",
  );
  expect(() => a.reset()).toThrow("API_BACKOFF");
  await vi.runAllTimersAsync();
  await vi.advanceTimersByTimeAsync(60000);
  a.reset();
  expect(await a.run("GeckoTerminal", "x", async () => 1)).toBe(1);
});
it("does not shorten a long Retry-After and does not retry automatically", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  await expect(
    a.run("Cetus", "x", async () => {
      throw new RateLimited("120");
    }),
  ).rejects.toThrow("API_RETRIES_EXHAUSTED");
  expect(a.snapshot()[2].nextRetryAt).toBe(Date.now() + 120000);
  expect(() => a.reset()).toThrow("API_BACKOFF");
});
it("invalidates cached market data as soon as any 429 occurs", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  const fn = vi.fn(async () => 2);
  await a.run("GeckoTerminal", "cached", fn, 20000);
  const p = expect(
    a.run("Cetus", "q", async () => {
      throw new RateLimited("120");
    }),
  ).rejects.toThrow();
  await p;
  await a.run("GeckoTerminal", "cached", fn, 20000);
  expect(fn).toHaveBeenCalledTimes(2);
});
it("does not stop on a transient 429 that a backoff retry answers", async () => {
  vi.useFakeTimers();
  const db = new BotDatabase(":memory:");
  const monitor = new OperationMonitor(db);
  const a = new ApiAccess();
  let stops = 0;
  a.onRateLimit = () => {
    stops++;
    monitor.stop("UPSTREAM_HTTP_429");
  };
  db.set("runtime", { ...db.runtime(), running: true });
  let calls = 0;
  const pending = a.run("Cetus", "q", async () => {
    if (!calls++) throw new RateLimited("5");
    return 2;
  });
  await flush();
  // One 429, retries still in flight: the bot keeps running.
  expect(stops).toBe(0);
  expect(db.runtime()).toMatchObject({ running: true, error: null });
  expect(a.snapshot()[2].backoff).toBe(true);
  await vi.runAllTimersAsync();
  expect(await pending).toBe(2);
  expect(stops).toBe(0);
  expect(db.runtime()).toMatchObject({ running: true, error: null });
  db.close();
});
it("stops exactly once when 429 retries are exhausted", async () => {
  vi.useFakeTimers();
  const db = new BotDatabase(":memory:");
  const monitor = new OperationMonitor(db);
  const a = new ApiAccess();
  let stops = 0;
  a.onRateLimit = () => {
    stops++;
    monitor.stop("UPSTREAM_HTTP_429");
  };
  db.set("runtime", { ...db.runtime(), running: true });
  const pending = expect(
    a.run("Cetus", "q", async () => {
      throw new RateLimited();
    }),
  ).rejects.toThrow("API_RETRIES_EXHAUSTED");
  await vi.runAllTimersAsync();
  await pending;
  expect(stops).toBe(1);
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "UPSTREAM_HTTP_429",
  });
  db.close();
});
it("cancels a retry wait immediately during shutdown", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  const fn = vi.fn(async () => {
    throw new RateLimited("30");
  });
  const pending = expect(a.run("Cetus", "q", fn)).rejects.toThrow(
    "API_CANCELLED",
  );
  await flush();
  a.cancel();
  await pending;
  expect(fn).toHaveBeenCalledTimes(1);
});
it("joins in-flight backoff without duplicate requests and rejects another key", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  let calls = 0;
  const fn = vi.fn(async () => {
    if (!calls++) throw new RateLimited("5");
    return 2;
  });
  const one = a.run("Cetus", "x", fn);
  await flush();
  const two = a.run("Cetus", "x", fn);
  await expect(a.run("Cetus", "y", fn)).rejects.toThrow("API_BACKOFF");
  expect(fn).toHaveBeenCalledTimes(1);
  await vi.runAllTimersAsync();
  expect(await Promise.all([one, two])).toEqual([2, 2]);
  expect(fn).toHaveBeenCalledTimes(2);
});
it("keeps exhausted API cooldowns across process restart", async () => {
  vi.useFakeTimers();
  const a = new ApiAccess();
  await expect(
    a.run("Cetus", "q", async () => {
      throw new RateLimited("120");
    }),
  ).rejects.toThrow();
  const b = new ApiAccess();
  b.restoreCooldowns(JSON.parse(JSON.stringify(a.snapshot())));
  expect(b.blocked()).toBe(true);
  expect(() => b.reset()).toThrow("API_BACKOFF");
  await vi.advanceTimersByTimeAsync(120001);
  await expect(b.run("Cetus", "q", async () => 2)).rejects.toThrow(
    "API_RETRIES_EXHAUSTED",
  );
  b.reset();
  expect(await b.run("Cetus", "q", async () => 2)).toBe(2);
});
it("detects an actual HTTP 429 and honors Retry-After through the HTTP transport", async () => {
  let calls = 0;
  const server = createServer((_, res) => {
    if (!calls++) {
      res.writeHead(429, { "Retry-After": "0" });
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address() as { port: number };
    expect(
      await (
        await apiFetch("GeckoTerminal", `http://127.0.0.1:${address.port}/`)
      ).json(),
    ).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(apiAccess.snapshot()[1].rateLimits).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("intercepts SDK HTTP calls before a caller can swallow the 429", async () => {
  let calls = 0;
  const server = createServer((_, res) => {
    if (!calls++) {
      res.writeHead(429, { "Retry-After": "0" });
      res.end();
    } else res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as { port: number };
    expect(
      await sdkRequests(async () =>
        (await fetch(`http://127.0.0.1:${port}/`)).text(),
      ),
    ).toBe("ok");
    expect(apiAccess.snapshot()[2]).toMatchObject({
      rateLimits: 1,
      retries: 1,
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("aborts a stalled real HTTP request rather than leaving a detached retry", async () => {
  const server = createServer(() => {});
  const timeout = apiLimits.timeoutMs;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    apiLimits.timeoutMs = 50;
    const { port } = server.address() as { port: number };
    await expect(
      apiFetch("GeckoTerminal", `http://127.0.0.1:${port}/timeout`),
    ).rejects.toThrow("UPSTREAM_TIMEOUT");
    expect(apiAccess.snapshot()[1].active).toBe(false);
  } finally {
    apiLimits.timeoutMs = timeout;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
