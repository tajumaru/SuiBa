import { afterEach, expect, it, vi } from "vitest";
import { requestIdentity } from "../packages/shared/src/http-errors.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});
const base = "https://deepbook-indexer.mainnet.mystenlabs.com";
it.each([
  ["/ohclv/SUI_USDC?interval=5m", "OHLCV_FETCH", "5m"],
  ["/ohclv/SUI_USDC?interval=1m", "OHLCV_FETCH", "1m"],
  ["/orderbook/SUI_USDC?level=2&depth=100", "ORDERBOOK_FETCH", undefined],
  ["/status?max_time_lag_seconds=60", "MARKET_STATUS", undefined],
  ["/get_pools", "PROVIDER_HEALTH", undefined],
  [
    "/trades/SUI_USDC?start_time=1&end_time=2",
    "TRADE_EVIDENCE_FETCH",
    undefined,
  ],
])(
  "identifies %s without logging arbitrary URL parameters",
  (path, operation, timeframe) => {
    const r = requestIdentity(
      "DeepBook Indexer",
      base + path + (path.includes("?") ? "&" : "?") + "api_key=DO_NOT_LOG",
      "GET",
    );
    expect(r.operation).toBe(operation);
    expect(r.timeframe).toBe(timeframe);
    expect(r.url).toBe(base + "/[redacted]");
    expect(JSON.stringify(r)).not.toContain("DO_NOT_LOG");
  },
);
it("does not trust lookalike hosts or non-allowlisted intervals", () => {
  expect(
    requestIdentity(
      "DeepBook Indexer",
      "https://deepbook-indexer.mainnet.mystenlabs.com.example/ohclv/SUI_USDC?interval=5m",
      "GET",
    ).operation,
  ).toBe("HTTP_READ");
  const r = requestIdentity(
    "DeepBook Indexer",
    base + "/ohclv/SUI_USDC?interval=SECRET",
    "GET",
  );
  expect(JSON.stringify(r)).not.toContain("SECRET");
});
it("logs a successful-operation timestamp, phase, duration and bounded retry count, and audits after stopping", async () => {
  vi.useFakeTimers({
    toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(Date.UTC(2026, 9, 22));
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (n++ === 0) return Response.json({ ok: true });
      throw new TypeError("secret header and private key", {
        cause: Object.assign(new Error("secret"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      });
    }),
  );
  vi.resetModules();
  const { apiAccess, apiFetch } = await import("../packages/shared/src/api.ts");
  const db = new BotDatabase(":memory:"),
    monitor = new OperationMonitor(db);
  db.set("runtime", { ...db.runtime(), running: true });
  apiAccess.onTransientFailure = (_api, code) => monitor.stop(code);
  apiAccess.onAttempt = (e) => {
    if (e.failure) {
      expect(db.runtime().running).toBe(false);
      monitor.apiFailure(e.failure);
    }
  };
  const url = base + "/ohclv/SUI_USDC?interval=5m&api_key=DO_NOT_LOG";
  await apiFetch("DeepBook Indexer", url);
  const succeededAt = Date.now();
  await vi.advanceTimersByTimeAsync(100);
  const request = apiFetch("DeepBook Indexer", url, undefined, 0, {
    maxTransientRetries: 2,
  });
  const rejected = expect(request).rejects.toThrow("UPSTREAM_HEADERS_TIMEOUT");
  await vi.runAllTimersAsync();
  await rejected;
  const events = db
    .range<any>("operation_events", 0, Date.now())
    .filter((e) => e.kind === "API");
  expect(events).toHaveLength(3);
  expect(events.map((e) => e.apiFailure.retryCount)).toEqual([0, 1, 2]);
  for (const e of events) {
    expect(e.apiFailure).toMatchObject({
      operation: "OHLCV_FETCH",
      timeframe: "5m",
      status: null,
      timeoutType: "HEADERS_OR_CONNECT",
      lastSuccessAt: succeededAt,
    });
    expect(e.apiFailure.endedAt).toBeGreaterThanOrEqual(e.apiFailure.startedAt);
    expect(e.apiFailure.elapsedMs).toBeGreaterThanOrEqual(0);
  }
  expect(JSON.stringify(events)).not.toMatch(
    /DO_NOT_LOG|private key|secret header/,
  );
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "UPSTREAM_HEADERS_TIMEOUT",
  });
  db.close();
});
it("keeps HTTP statuses separate and does not treat a 503 as a timeout", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 503 })),
  );
  vi.resetModules();
  const { apiAccess, apiFetch } = await import("../packages/shared/src/api.ts");
  await expect(
    apiFetch("DeepBook Indexer", base + "/orderbook/SUI_USDC"),
  ).rejects.toThrow("UPSTREAM_HTTP_503");
  const s = apiAccess.snapshot().find((a) => a.api === "DeepBook Indexer");
  expect(s?.lastFailure).toMatchObject({
    operation: "ORDERBOOK_FETCH",
    status: 503,
    timeoutType: null,
    retryCount: 0,
    lastSuccessAt: null,
  });
});
