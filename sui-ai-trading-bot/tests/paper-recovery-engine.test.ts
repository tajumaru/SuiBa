import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
import type { ApiFailure } from "../packages/shared/src/http-errors.ts";
import type { MarketStatus } from "../packages/market-data/src/provider.ts";
import {
  atomic,
  units,
  USDC,
  SUI,
  type Candle,
  type Timeframe,
  type QuoteResult,
  type QuoteRequest,
} from "../packages/shared/src/index.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import { ValidationRecorder } from "../apps/worker/src/validation.ts";
import {
  ReadOnlySuiClient,
  type SuiObservation,
} from "../packages/sui-client/src/index.ts";
import { GrpcTypes } from "@mysten/sui/grpc";

const dbs: BotDatabase[] = [];
const realClients: ReadOnlySuiClient[] = [];

// Investigation-only regressions: exercise the real SDK decoding and engine,
// with synthetic HTTP responses and an isolated in-memory database.
it.each([
  "grpc-unavailable",
  "missing-metadata",
  "wrong-decimals",
  "decode",
  "http-403",
])(
  "investigation: %s health failure prevents market acquisition and latches SUI_READ_FAILED after transport recovers",
  async (mode) => {
    const t = fixture(),
      events: SuiObservation[] = [];
    let restored = false,
      success = 0;
    const client = new ReadOnlySuiClient(undefined, {
      onObservation: (event) => events.push(event),
      fetch: async () => {
        if (!restored && mode === "http-403")
          return new Response(null, { status: 403 });
        if (!restored && mode === "grpc-unavailable")
          return new Response("", {
            headers: {
              "content-type": "application/grpc-web-text",
              "grpc-status": "14",
            },
          });
        if (!restored && mode === "decode")
          return new Response("invalid-frame", {
            headers: { "content-type": "application/grpc-web-text" },
          });
        const payload = GrpcTypes.GetCoinInfoResponse.toBinary(
          GrpcTypes.GetCoinInfoResponse.create({
            ...(restored || mode !== "missing-metadata"
              ? {
                  metadata: {
                    decimals: restored ? (success++ % 2 ? 6 : 9) : 33,
                  },
                }
              : {}),
          }),
        );
        const frame = (flag: number, bytes: Uint8Array) => {
          const b = Buffer.alloc(5 + bytes.length);
          b[0] = flag;
          b.writeUInt32BE(bytes.length, 1);
          b.set(bytes, 5);
          return b;
        };
        return new Response(
          Buffer.concat([
            frame(0, payload),
            frame(128, Buffer.from("grpc-status: 0\r\n")),
          ]).toString("base64"),
          { headers: { "content-type": "application/grpc-web-text" } },
        );
      },
    });
    realClients.push(client);
    Object.defineProperty(t.sui, "status", { get: () => client.status });
    t.sui.health.mockImplementation((force) => client.health(force));
    await t.tick();
    expect(t.market.frames).not.toHaveBeenCalled();
    expect(t.db.runtime()).toMatchObject({
      running: false,
      error: "SUI_READ_FAILED",
    });
    expect(events.some((e) => e.layer === "METADATA" && !e.success)).toBe(true);
    expect(
      t.db
        .history<{ code: string }>("operation_events")
        .some((e) => e.code === "HEALTH_SUI_READ_FAILED"),
    ).toBe(true);
    restored = true;
    await t.tick(60000);
    expect(client.status.healthy).toBe(true);
    expect(t.market.frames).toHaveBeenCalledTimes(1);
    // Successful communication does not clear a hard stop/operator-review latch.
    expect(t.db.runtime()).toMatchObject({
      running: false,
      error: "SUI_READ_FAILED",
    });
    expect(t.engine.monitor.ordersAllowed()).toBe(false);
    expect(t.db.history("paper_orders")).toHaveLength(0);
    expect(t.db.history("paper_trades")).toHaveLength(0);
  },
);

it("investigation: an auxiliary balance DNS failure pauses a running engine before the next tick", async () => {
  const t = fixture();
  const client = new ReadOnlySuiClient(undefined, {
    fetch: async () => {
      throw new TypeError("fixture", {
        cause: Object.assign(Error("fixture"), { code: "EAI_AGAIN" }),
      });
    },
  });
  realClients.push(client);
  await expect(client.balance("0x" + "1".repeat(64), SUI)).rejects.toThrow(
    "SUI_READ_FAILED",
  );
  expect(t.sui.health).not.toHaveBeenCalled();
  expect(t.db.runtime()).toMatchObject({ running: false, error: null });
  expect(t.engine.monitor.safety()).toMatchObject({
    connectivity: "DEGRADED",
    resumePending: true,
  });
  expect(t.engine.monitor.ordersAllowed()).toBe(false);
  expect(t.db.history("paper_orders")).toHaveLength(0);
});

function investigationMetadataResponse(decimals: number) {
  const payload = GrpcTypes.GetCoinInfoResponse.toBinary(
    GrpcTypes.GetCoinInfoResponse.create({ metadata: { decimals } }),
  );
  const frame = (flag: number, bytes: Uint8Array) => {
    const b = Buffer.alloc(5 + bytes.length);
    b[0] = flag;
    b.writeUInt32BE(bytes.length, 1);
    b.set(bytes, 5);
    return b;
  };
  return new Response(
    Buffer.concat([
      frame(0, payload),
      frame(128, Buffer.from("grpc-status: 0\r\n")),
    ]).toString("base64"),
    { headers: { "content-type": "application/grpc-web-text" } },
  );
}

it("investigation: first Sui 429 keeps its stop reason after a successful retry and later healthy ticks", async () => {
  const t = fixture();
  let calls = 0,
    successes = 0;
  const client = new ReadOnlySuiClient(undefined, {
    fetch: async () => {
      if (calls++ === 0)
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      return investigationMetadataResponse(successes++ % 2 ? 6 : 9);
    },
  });
  realClients.push(client);
  Object.defineProperty(t.sui, "status", { get: () => client.status });
  t.sui.health.mockImplementation((force) => client.health(force));
  const ticking = t.tick();
  await vi.advanceTimersByTimeAsync(1);
  await ticking;
  expect(calls).toBe(3);
  expect(client.status.healthy).toBe(true);
  expect(t.db.runtime()).toMatchObject({
    running: false,
    error: "UPSTREAM_HTTP_429",
  });
  expect(t.engine.monitor.ordersAllowed()).toBe(false);
  await t.tick(60000);
  expect(t.db.runtime()).toMatchObject({
    running: false,
    error: "UPSTREAM_HTTP_429",
  });
  expect(t.db.history("paper_orders")).toHaveLength(0);
  expect(t.db.history("paper_trades")).toHaveLength(0);
});

it.each([2, 4])(
  "investigation: %i consecutive partial Sui outages recover only before the episode deadline",
  async (failedCycles) => {
    const t = fixture();
    let fail = true,
      calls = 0;
    const client = new ReadOnlySuiClient(undefined, {
      fetch: async () => {
        const sui = calls++ % 2 === 0;
        if (fail && sui)
          throw new TypeError("fixture", {
            cause: Object.assign(Error("fixture"), { code: "EAI_AGAIN" }),
          });
        return investigationMetadataResponse(sui ? 9 : 6);
      },
    });
    realClients.push(client);
    Object.defineProperty(t.sui, "status", { get: () => client.status });
    t.sui.health.mockImplementation((force) => client.health(force));
    for (let i = 0; i < failedCycles; i++) {
      await t.tick(i ? 30000 : 0);
      expect(t.db.runtime()).toMatchObject({ running: false, error: null });
      expect(t.engine.monitor.ordersAllowed()).toBe(false);
    }
    expect(t.market.frames).not.toHaveBeenCalled();
    fail = false;
    await t.tick(30000);
    expect(client.status.healthy).toBe(true);
    expect(t.engine.monitor.safety().connectivity).toBe("RECOVERING");
    expect(t.db.runtime().running).toBe(false);
    await t.tick(60000);
    if (failedCycles === 2) {
      expect(t.db.runtime()).toMatchObject({ running: true, error: null });
      expect(t.engine.monitor.safety().connectivity).toBe("HEALTHY");
    } else {
      // At 180s the episode expires even though transport and metadata recover.
      expect(t.db.runtime()).toMatchObject({
        running: false,
        error: "PAPER_RECOVERY_EXHAUSTED",
      });
      expect(t.engine.monitor.ordersAllowed()).toBe(false);
    }
    expect(t.db.history("paper_orders")).toHaveLength(0);
    expect(t.db.history("paper_trades")).toHaveLength(0);
  },
);

it("investigation: one health failure is counted by HEALTH and MARKET and the next reaches the consecutive-error stop", async () => {
  const t = fixture();
  t.sui.health.mockRejectedValue(Error("SUI_READ_FAILED"));
  await t.tick();
  expect(t.engine.monitor.state()).toMatchObject({
    apiErrors: 2,
    consecutiveErrors: 2,
  });
  expect(t.db.runtime().error).toBe("SUI_READ_FAILED");
  await t.tick(60000);
  expect(t.engine.monitor.state()).toMatchObject({
    apiErrors: 4,
    consecutiveErrors: 4,
  });
  expect(
    t.db
      .history<{ code: string }>("operation_events")
      .some((e) => e.code === "CONSECUTIVE_API_ERRORS"),
  ).toBe(true);
  // The runtime preserves the first hard error, while safety holds the last stop.
  expect(t.db.runtime().error).toBe("SUI_READ_FAILED");
  expect(t.engine.monitor.safety().lastStopReason).toBe("SUI_READ_FAILED");
  expect(t.db.history("paper_orders")).toHaveLength(0);
});

it("investigation: auxiliary failure during pending health invalidates both late metadata successes and requires fresh recovery cycles", async () => {
  const t = fixture();
  const client = new ReadOnlySuiClient(undefined, {
    fetch: async () => {
      throw Error("EXTERNAL_NETWORK_FORBIDDEN");
    },
  });
  realClients.push(client);
  const releases: (() => void)[] = [];
  const metadata = vi.fn(
    ({ coinType }: { coinType: string }) =>
      new Promise<{ coinMetadata: { decimals: number } }>((resolve) => {
        releases.push(() =>
          resolve({ coinMetadata: { decimals: coinType === SUI ? 9 : 6 } }),
        );
      }),
  );
  // SDK boundary injection allows the exact read/health interleaving to be
  // controlled, independent from the transport's per-API serialization.
  (client as unknown as { client: unknown }).client = {
    getCoinMetadata: metadata,
    getBalance: async () => {
      t.fault({
        api: "Sui gRPC",
        host: "fullnode.mainnet.sui.io",
        url: "https://fullnode.mainnet.sui.io/[redacted]",
        operation: "SUI_GRPC_READ",
        code: "UPSTREAM_DNS_FAILED",
        phase: "DNS",
        timeoutType: null,
        causeCode: "EAI_AGAIN",
      });
      throw Error("fixture");
    },
  };
  Object.defineProperty(t.sui, "status", { get: () => client.status });
  t.sui.health.mockImplementation((force) => client.health(force));
  const ticking = t.tick();
  expect(metadata).toHaveBeenCalledTimes(2);
  await expect(client.balance("0x" + "1".repeat(64), SUI)).rejects.toThrow(
    "SUI_READ_FAILED",
  );
  releases.forEach((release) => release());
  await ticking;
  expect(client.status.healthy).toBe(false);
  expect(t.market.frames).not.toHaveBeenCalled();
  expect(t.db.runtime()).toMatchObject({ running: false, error: null });
  expect(t.engine.monitor.safety().connectivity).toBe("DEGRADED");
  expect(t.engine.monitor.ordersAllowed()).toBe(false);
  metadata.mockImplementation(({ coinType }) =>
    Promise.resolve({ coinMetadata: { decimals: coinType === SUI ? 9 : 6 } }),
  );
  await t.tick(60000);
  expect(metadata).toHaveBeenCalledTimes(4);
  expect(t.engine.monitor.safety().connectivity).toBe("RECOVERING");
  expect(t.db.runtime().running).toBe(false);
  await t.tick(60000);
  expect(metadata).toHaveBeenCalledTimes(6);
  expect(t.engine.monitor.safety().connectivity).toBe("HEALTHY");
  expect(t.db.runtime().running).toBe(true);
  expect(t.db.history("paper_orders")).toHaveLength(0);
  expect(t.db.history("paper_trades")).toHaveLength(0);
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 23, 0, 1));
});
afterEach(async () => {
  // New transport fixtures also exercise the shared breaker. Close it through
  // its real successful probe so one synthetic outage cannot leak into another.
  const probe = apiAccess.run(
    "Sui gRPC",
    "investigation-cleanup",
    async () => undefined,
  );
  await vi.runAllTimersAsync();
  await probe;
  for (const client of realClients.splice(0)) client.close();
  for (const db of dbs.splice(0)) db.close();
  apiAccess.restoreCooldowns(
    apiAccess
      .snapshot()
      .map((a) => ({ api: a.api, nextRetryAt: null, exhausted: false })),
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it.each([false, true])(
  "integrates actual Sui health/observations with guarded recovery (manual stop=%s)",
  async (manuallyStopped) => {
    const t = fixture(),
      observations: SuiObservation[] = [];
    let fail = true,
      calls = 0,
      successes = 0;
    const client = new ReadOnlySuiClient(undefined, {
      fetch: async () => {
        calls++;
        if (fail)
          throw new TypeError("fixture", {
            cause: Object.assign(Error("fixture"), { code: "EAI_AGAIN" }),
          });
        const bytes = GrpcTypes.GetCoinInfoResponse.toBinary(
          GrpcTypes.GetCoinInfoResponse.create({
            metadata: { decimals: successes++ % 2 ? 6 : 9 },
          }),
        );
        const frame = (flag: number, payload: Uint8Array) => {
          const b = Buffer.alloc(5 + payload.length);
          b[0] = flag;
          b.writeUInt32BE(payload.length, 1);
          b.set(payload, 5);
          return b;
        };
        return new Response(
          Buffer.concat([
            frame(0, bytes),
            frame(128, Buffer.from("grpc-status: 0\r\n")),
          ]).toString("base64"),
          { headers: { "content-type": "application/grpc-web-text" } },
        );
      },
      onObservation: (e) => observations.push(e),
    });
    realClients.push(client);
    Object.defineProperty(t.sui, "status", { get: () => client.status });
    t.sui.health.mockImplementation((force) => client.health(force));
    if (manuallyStopped) {
      t.db.set("runtime", { ...t.db.runtime(), running: false });
      t.engine.monitor.transition("MANUAL_STOP");
    }
    await t.tick();
    expect(t.engine.monitor.safety().connectivity).toBe("DEGRADED");
    expect(t.db.runtime().running).toBe(false);
    expect(client.status.healthy).toBe(false);
    fail = false;
    await t.tick(60000);
    expect(t.engine.monitor.safety().connectivity).toBe("RECOVERING");
    expect(t.db.runtime().running).toBe(false);
    await t.tick(60000);
    expect(t.engine.monitor.safety().connectivity).toBe("HEALTHY");
    expect(t.db.runtime().running).toBe(!manuallyStopped);
    expect(calls).toBe(6);
    expect(observations.every((e) => !!e.cycleId)).toBe(true);
    expect(t.db.history("paper_orders")).toHaveLength(0);
    expect(t.db.history("paper_trades")).toHaveLength(0);
  },
);
function bars(tf: Timeframe): Candle[] {
  const end = Math.floor(Date.now() / (tf * 1000)) * tf - tf;
  return Array.from({ length: 70 }, (_, i) => ({
    timestamp: end - (69 - i) * tf,
    timeframe: tf,
    source: "DeepBook:SUI_USDC:USDC:verified-v1",
    open: 2,
    high: 2.1,
    low: 1.9,
    close: 2,
    volume: 10000,
  }));
}
function fixture(database?: BotDatabase, deploymentBlocked?: () => boolean) {
  const db = database ?? new BotDatabase(":memory:");
  dbs.push(db);
  db.set("runtime", { ...db.runtime(), running: true });
  db.updateSettings({ ...db.settings(), takeProfitPct: 0.3 });
  let inject: (() => void) | undefined,
    stale = false,
    staleBook = false;
  const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const sui = {
    status: health,
    health: vi.fn(async (_force = false) => {
      health.healthy = true;
      health.checkedAt = Date.now();
      return health;
    }),
  };
  const status = (): MarketStatus => ({
    configured: "deepbook",
    source: "DeepBook",
    fallback: false,
    healthy: true,
    lastSuccessAt: Date.now(),
    latencyMs: 1,
    reason: null,
    bookAt: Date.now() - (staleBook ? 11000 : 0),
    bid: 1.999,
    ask: 2.001,
    spread: 0.001,
    diagnostics: {
      indexerLagMs: 1000,
      indexedThrough: Date.now() - 1000,
      bidDepthUsdc: 100,
      askDepthUsdc: 100,
    },
    quality: Object.fromEntries(
      ([300, 900, 3600] as const).map((tf) => [
        tf,
        {
          upstream: "DeepBook Indexer",
          pair: "SUI_USDC",
          timeframe: tf,
          fetchedAt: Date.now(),
          originalCount: 70,
          missing: 0,
          reconstructed: 0,
          unresolved: 0,
          reconstructionMs: 0,
          latestClosedAt: (bars(tf).at(-1)!.timestamp + tf) * 1000,
          origins: {
            ORIGINAL: 70,
            ONE_MINUTE_AGGREGATE: 0,
            NO_INDEXED_TRADES: 0,
          },
        },
      ]),
    ),
  });
  const market = {
    status,
    assertReady: () => {
      if (staleBook) throw Error("STALE_ORDERBOOK");
    },
    refreshForOrder: vi.fn(async () => {}),
    candles: async (tf: Timeframe) => bars(tf),
    frames: vi.fn(async () => {
      inject?.();
      return Object.fromEntries(
        ([300, 900, 3600] as const).map((tf) => [
          tf,
          bars(tf).map((c) => ({
            ...c,
            timestamp: c.timestamp - (stale ? 7200 : 0),
          })),
        ]),
      );
    }),
  };
  const router = {
    getQuote: vi.fn(async (r: QuoteRequest): Promise<QuoteResult> => {
      const buy = r.from === USDC,
        output = buy ? units(r.amountIn, USDC) / 2 : units(r.amountIn, SUI) * 2;
      return {
        ...r,
        amountOut: atomic(output, buy ? SUI : USDC),
        minAmountOut: atomic(output * 0.997, buy ? SUI : USDC),
        id: "mock",
        liquid: true,
        priceImpact: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + 15000,
        route: ["mock"],
        source: "mock",
        dexFeeUsdc: null,
      };
    }),
    validateQuote: vi.fn(async (_q: QuoteResult) => true),
  };
  const engine = new BotEngine(
    db,
    market,
    router,
    sui,
    "SUI_USDC",
    deploymentBlocked,
  );
  vi.spyOn(RuleBasedStrategy.prototype, "analyze").mockResolvedValue({
    action: "WAIT",
    confidence: 1,
    reason: "mock",
    timestamp: "mock",
    stopLossPct: 0.02,
    takeProfitPct: 0.3,
  });
  const fault = (patch: Partial<ApiFailure> = {}) => {
    const f: ApiFailure = {
      api: "DeepBook Indexer",
      host: "deepbook-indexer.mainnet.mystenlabs.com",
      url: "https://deepbook-indexer.mainnet.mystenlabs.com/[redacted]",
      method: "GET",
      operation: "OHLCV_FETCH",
      code: "UPSTREAM_BODY_TIMEOUT",
      phase: "BODY",
      timeoutType: "BODY",
      causeCode: null,
      status: null,
      elapsedMs: 8000,
      occurredAt: Date.now(),
      ...patch,
    };
    apiAccess.onTransientFailure(f.api, f.code, f);
    return f;
  };
  const tick = async (advance = 0) => {
    vi.setSystemTime(Date.now() + advance);
    await engine.tick();
  };
  return {
    db,
    engine,
    market,
    router,
    sui,
    fault,
    tick,
    inject: (fn?: () => void) => {
      inject = fn;
    },
    stale: () => {
      stale = true;
    },
    staleBook: () => {
      staleBook = true;
    },
  };
}

it("retry success cannot reopen orders in the failure cycle; clean full cycles recover PAPER", async () => {
  const t = fixture();
  t.inject(() => {
    t.fault();
    t.inject();
  });
  await t.tick();
  expect(t.engine.monitor.safety().connectivity).toBe("DEGRADED");
  expect(t.db.runtime()).toMatchObject({ running: false, error: null });
  expect(t.router.getQuote).not.toHaveBeenCalled();
  await t.tick(60000);
  expect(t.engine.monitor.safety().connectivity).toBe("RECOVERING");
  expect(t.sui.health).toHaveBeenLastCalledWith(true);
  await t.tick(60000);
  expect(t.db.runtime().running).toBe(true);
  expect(t.db.history("paper_trades")).toHaveLength(0);
  expect(
    t.db
      .history<any>("operation_events")
      .filter((e) => e.code === "PAPER_NETWORK_RECOVERED"),
  ).toHaveLength(1);
});
it.each(["BODY", "DNS", "CONNECT", "TLS", "gRPC"])(
  "handles an evidenced %s failure at final acquisition failure without a hard error",
  async (kind) => {
    const t = fixture();
    if (kind === "gRPC")
      t.sui.health.mockImplementationOnce(async () => {
        t.fault({
          api: "Sui gRPC",
          host: "fullnode.mainnet.sui.io",
          operation: "SUI_GRPC_READ",
          code: "UPSTREAM_NETWORK_FAILED",
          phase: "CONNECT",
          timeoutType: null,
          causeCode: "ECONNRESET",
        });
        throw Error("SUI_READ_FAILED");
      });
    else
      t.inject(() => {
        const f = t.fault(
          kind === "DNS"
            ? {
                code: "UPSTREAM_DNS_FAILED",
                phase: "DNS",
                causeCode: "EAI_AGAIN",
                timeoutType: null,
              }
            : {},
        );
        t.inject();
        throw Error(f.code);
      });
    await t.tick();
    expect(t.db.runtime()).toMatchObject({ running: false, error: null });
    expect(t.engine.monitor.safety().resumePending).toBe(true);
    await t.tick(60000);
    await t.tick(60000);
    expect(t.db.runtime().running).toBe(true);
  },
);
it.each(["candles", "book", "ledger"])(
  "hard-stops on invalid %s after transport recovery",
  async (kind) => {
    const t = fixture();
    t.fault();
    if (kind === "candles") t.stale();
    if (kind === "book") t.staleBook();
    if (kind === "ledger")
      t.db.set("portfolio", { ...t.db.portfolio(), usdc: -1 });
    await t.tick(60000);
    expect(t.db.runtime().error).toBe(
      kind === "candles"
        ? "STALE_CANDLES"
        : kind === "book"
          ? "STALE_ORDERBOOK"
          : "PAPER_RECONCILIATION_FAILED",
    );
    expect(t.engine.monitor.safety().resumePending).toBe(false);
    expect(t.db.history("paper_trades")).toHaveLength(0);
  },
);
it("does not count recovery cycles while any API is in backoff", async () => {
  const t = fixture();
  t.fault();
  apiAccess.restoreCooldowns([
    {
      api: "DeepBook Indexer",
      nextRetryAt: Date.now() + 120000,
      exhausted: false,
    },
  ]);
  await t.tick(60000);
  expect(t.engine.monitor.safety().healthyCycles).toBe(0);
  expect(t.db.runtime().running).toBe(false);
});
it("a new failure during recovery resets the complete proof", async () => {
  const t = fixture();
  t.fault();
  await t.tick(60000);
  t.inject(() => {
    t.fault();
    t.inject();
  });
  await t.tick(60000);
  expect(t.engine.monitor.safety()).toMatchObject({
    connectivity: "DEGRADED",
    healthyCycles: 0,
  });
  expect(t.db.runtime().running).toBe(false);
});
it("deployment maintenance and gate read failures stop a running engine before acquisition", async () => {
  for (const gate of [
    () => true,
    () => {
      throw Error("unreadable");
    },
  ]) {
    const t = fixture(undefined, gate);
    await t.tick();
    expect(t.db.runtime().running).toBe(false);
    expect(t.market.frames).not.toHaveBeenCalled();
    expect(t.db.history("paper_trades")).toHaveLength(0);
  }
});

it("deployment maintenance arriving during async quote validation prevents a fill", async () => {
  let maintenance = false;
  const t = fixture(undefined, () => maintenance);
  vi.mocked(RuleBasedStrategy.prototype.analyze).mockResolvedValue({
    action: "BUY",
    confidence: 1,
    reason: "fixture",
    timestamp: "fixture",
    stopLossPct: 0.02,
    takeProfitPct: 0.3,
  });
  let validations = 0;
  t.router.validateQuote.mockImplementation(async () => {
    if (++validations === 3) maintenance = true;
    return true;
  });
  await t.tick();
  expect(validations).toBe(3);
  expect(t.db.runtime().running).toBe(false);
  expect(t.db.history("paper_trades")).toHaveLength(0);
});

it("maintenance detected at the final fill boundary closes the pending candidate", async () => {
  let maintenance = false;
  const t = fixture(undefined, () => maintenance);
  vi.mocked(RuleBasedStrategy.prototype.analyze).mockResolvedValue({
    action: "BUY",
    confidence: 1,
    reason: "fixture",
    timestamp: "fixture",
    stopLossPct: 0.02,
    takeProfitPct: 0.3,
  });
  let checks = 0;
  vi.spyOn(t.market, "assertReady").mockImplementation(() => {
    if (++checks === 1) maintenance = true;
  });
  await t.tick();
  expect(checks).toBe(1);
  expect(t.db.runtime().running).toBe(false);
  expect(t.db.history("paper_trades")).toHaveLength(0);
  expect(t.db.history("operation_candidates")[0]).toMatchObject({
    finalAction: "WAIT",
    reasons: ["DEPLOYMENT_MAINTENANCE"],
  });
});

it("late communication failure immediately before execution prevents an otherwise eligible fill", async () => {
  const t = fixture();
  vi.mocked(RuleBasedStrategy.prototype.analyze).mockResolvedValue({
    action: "BUY",
    confidence: 1,
    reason: "mock",
    timestamp: "mock",
    stopLossPct: 0.02,
    takeProfitPct: 0.3,
  });
  let validations = 0;
  t.router.validateQuote.mockImplementation(async () => {
    if (++validations === 3) t.fault();
    return true;
  });
  await t.tick();
  expect(validations).toBe(3);
  expect(t.db.history("paper_trades")).toHaveLength(0);
  expect(t.engine.monitor.ordersAllowed()).toBe(false);
  expect(t.market.refreshForOrder).toHaveBeenCalledOnce();
});
it("manual stop/start during async validation invalidates the old execution generation", async () => {
  const t = fixture();
  vi.mocked(RuleBasedStrategy.prototype.analyze).mockResolvedValue({
    action: "BUY",
    confidence: 1,
    reason: "mock",
    timestamp: "mock",
    stopLossPct: 0.02,
    takeProfitPct: 0.3,
  });
  let validations = 0;
  t.router.validateQuote.mockImplementation(async () => {
    if (++validations === 3) {
      t.db.set("runtime", { ...t.db.runtime(), running: false });
      t.engine.monitor.transition("MANUAL_STOP");
      t.db.set("runtime", { ...t.db.runtime(), running: true });
      t.engine.monitor.transition("MANUAL_START");
    }
    return true;
  });
  await t.tick();
  expect(validations).toBe(3);
  expect(t.db.history("paper_trades")).toHaveLength(0);
});
it("serializes ticks and never resumes after a process boot", async () => {
  const t = fixture();
  let release!: (v: Record<number, Candle[]>) => void;
  t.market.frames.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const first = t.engine.tick();
  await vi.advanceTimersByTimeAsync(0);
  await t.engine.tick();
  expect(t.market.frames).toHaveBeenCalledOnce();
  release({ 300: bars(300), 900: bars(900), 3600: bars(3600) });
  await first;
  t.fault();
  t.engine.monitor.boot();
  await t.tick(60000);
  await t.tick(60000);
  expect(t.db.runtime().running).toBe(false);
  expect(t.engine.monitor.safety().resumePending).toBe(false);
});

it("records guarded recovery evidence without weakening unauthorized-run detection", async () => {
  const t = fixture(),
    recorder = new ValidationRecorder(t.db);
  t.db.set("runtime", { ...t.db.runtime(), running: false });
  recorder.begin(Date.now());
  vi.setSystemTime(Date.now() + 1);
  t.db.set("runtime", { ...t.db.runtime(), running: true });
  t.engine.monitor.transition("MANUAL_START");
  t.engine.validation = recorder;
  t.inject(() => {
    const f = t.fault();
    t.inject();
    recorder.attempt({
      api: f.api,
      success: false,
      code: f.code,
      latencyMs: 8000,
      attempt: 0,
      occurredAt: f.occurredAt,
      failure: f,
    });
  });
  await t.tick();
  await t.tick(60000);
  await t.tick(60000);
  recorder.sample(t.market.status());
  let report = recorder.report(Date.now(), true);
  expect(report.paper).toMatchObject({
    guardedRecoveries: 1,
    unauthorizedRuns: 0,
    missingSafetyStops: 0,
  });
  t.db.set("runtime", { ...t.db.runtime(), running: false });
  t.engine.monitor.transition("MANUAL_STOP");
  vi.setSystemTime(Date.now() + 1000);
  t.db.set("runtime", { ...t.db.runtime(), running: true });
  t.engine.monitor.event("CONTROL", "PAPER_NETWORK_RECOVERED"); // A code without proof must not authorize resumption.
  recorder.sample(t.market.status());
  report = recorder.report(Date.now(), true);
  expect(report.paper?.guardedRecoveries).toBe(1);
  expect(report.paper?.unauthorizedRuns).toBe(1);
});

it("rechecks the book immediately before execution even after successful quote validation", async () => {
  const t = fixture();
  vi.mocked(RuleBasedStrategy.prototype.analyze).mockResolvedValue({
    action: "BUY",
    confidence: 1,
    reason: "mock",
    timestamp: "mock",
    stopLossPct: 0.02,
    takeProfitPct: 0.3,
  });
  let validations = 0;
  t.router.validateQuote.mockImplementation(async () => {
    if (++validations === 3) t.staleBook();
    return true;
  });
  await t.tick();
  expect(validations).toBe(3);
  expect(t.db.runtime().error).toBe("STALE_ORDERBOOK");
  expect(t.db.history("paper_trades")).toHaveLength(0);
});

it.each(["unresolved", "old quality", "indexer"])(
  "does not recover with %s market proof",
  async (kind) => {
    const t = fixture(),
      original = t.market.status;
    vi.spyOn(t.market, "status").mockImplementation(() => {
      const s = original();
      if (kind === "unresolved") s.quality![300].unresolved = 1;
      if (kind === "old quality")
        s.quality![300].fetchedAt = Date.now() - 60000;
      if (kind === "indexer") s.diagnostics!.indexerLagMs = 61000;
      return s;
    });
    t.fault();
    await t.tick(60000);
    await t.tick(60000);
    expect(t.db.runtime().running).toBe(false);
    expect(t.engine.monitor.safety().healthyCycles).toBe(0);
  },
);

it("classifies stopped and recovery-confirmation analyses separately from eligible running analyses", async () => {
  const t = fixture(),
    recorder = new ValidationRecorder(t.db);
  t.db.set("runtime", { ...t.db.runtime(), running: false });
  recorder.begin();
  t.db.set("runtime", { ...t.db.runtime(), running: true });
  t.engine.monitor.transition("MANUAL_START");
  t.engine.validation = recorder;
  t.inject(() => {
    t.fault();
    t.inject();
  });
  await t.tick();
  await t.tick(60000);
  await t.tick(60000);
  expect(recorder.report(Date.now(), true).paper).toMatchObject({
    analyses: 3,
    runningAnalyses: 0,
    stoppedAnalyses: 2,
    gatedAnalyses: 1,
    unknownAnalysisState: 0,
    unevaluatedCycles: 0,
  });
  expect(
    t.db
      .history<any>("cycle_audits")
      .filter((e) => e.phase === "END")
      .map((e) => e.outcome),
  ).toContain("RECOVERY_CONFIRMATION");
  expect(t.db.history("paper_trades")).toHaveLength(0);
});

it("evidence storage failure hard-stops the engine and recovery cannot restart it", async () => {
  const t = fixture();
  const client = new ReadOnlySuiClient(undefined, {
    fetch: async () =>
      new Response("", {
        headers: {
          "content-type": "application/grpc-web-text",
          "grpc-status": "14",
        },
      }),
    onObservation: () => {
      throw Error("fixture DB failure");
    },
  });
  realClients.push(client);
  Object.defineProperty(t.sui, "status", { get: () => client.status });
  t.sui.health.mockImplementation((force) => client.health(force));
  await t.tick();
  expect(t.db.runtime()).toMatchObject({
    running: false,
    error: "VALIDATION_RECORD_FAILED",
  });
  await t.tick(60000);
  await t.tick(60000);
  expect(t.db.runtime().running).toBe(false);
  expect(t.engine.monitor.safety().resumePending).toBe(false);
  expect(t.db.history("paper_orders")).toHaveLength(0);
  expect(t.db.history("paper_trades")).toHaveLength(0);
});

it.each([false, true])(
  "actual DB lock during Sui evidence closes engine gate (manual=%s)",
  async (manual) => {
    const path = join(
      mkdtempSync(join(tmpdir(), "suiba-engine-lock-")),
      "fixture.sqlite",
    );
    const t = fixture(new BotDatabase(path)),
      lock = new DatabaseSync(path);
    if (manual) {
      t.db.set("runtime", { ...t.db.runtime(), running: false });
      t.engine.monitor.transition("MANUAL_STOP");
    }
    let held = false;
    const client = new ReadOnlySuiClient(undefined, {
      fetch: async () => {
        if (!held) {
          lock.exec("BEGIN IMMEDIATE");
          held = true;
        }
        return new Response("", {
          headers: {
            "content-type": "application/grpc-web-text",
            "grpc-status": "14",
          },
        });
      },
      onObservation: (event) =>
        t.db.append(
          "sui_observations",
          String(event.at) + event.layer,
          event,
          event.at,
        ),
    });
    realClients.push(client);
    Object.defineProperty(t.sui, "status", { get: () => client.status });
    t.sui.health.mockImplementation((force) => client.health(force));
    try {
      // Production scheduler treats this rejection as fatal and exits; no order
      // execution can follow in the failed cycle even though SQL can recover.
      await expect(t.tick()).rejects.toMatchObject({ errcode: 5 });
      expect(t.db.health()).toMatchObject({
        healthy: true,
        requiresRestart: false,
      });
      expect(t.engine.monitor.ordersAllowed()).toBe(false);
      expect(t.market.frames).not.toHaveBeenCalled();
      lock.exec("ROLLBACK");
      held = false;
      for (let n = 0; n < 3; n++) await t.tick(60000);
      await expect(client.health(true)).rejects.toThrow(
        "VALIDATION_RECORD_FAILED",
      );
      // A failed stop cannot be persisted while the writer lock is held.
      // The production worker exits on the rejected tick, rather than resuming.
      expect(t.db.runtime().running).toBe(!manual);
      expect(t.engine.monitor.ordersAllowed()).toBe(false);
      expect(t.router.getQuote).not.toHaveBeenCalled();
      expect(t.db.history("paper_orders")).toHaveLength(0);
      expect(t.db.history("paper_trades")).toHaveLength(0);
    } finally {
      if (held) lock.exec("ROLLBACK");
      lock.close();
    }
  },
);
