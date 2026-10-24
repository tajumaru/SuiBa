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
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 23, 0, 1));
});
afterEach(() => {
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
function fixture(database?: BotDatabase) {
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
  const engine = new BotEngine(db, market, router, sui);
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
      await expect(t.tick()).rejects.toThrow("DATABASE_UNAVAILABLE");
      expect(t.db.health().healthy).toBe(false);
      expect(t.db.runtime()).toMatchObject({
        running: false,
        error: "DATABASE_UNAVAILABLE",
      });
      expect(t.engine.monitor.ordersAllowed()).toBe(false);
      expect(t.market.frames).not.toHaveBeenCalled();
      lock.exec("ROLLBACK");
      held = false;
      for (let n = 0; n < 3; n++)
        await expect(t.tick(60000)).rejects.toThrow("DATABASE_UNAVAILABLE");
      expect(t.router.getQuote).not.toHaveBeenCalled();
      expect(t.db.history("paper_orders")).toHaveLength(0);
      expect(t.db.history("paper_trades")).toHaveLength(0);
    } finally {
      if (held) lock.exec("ROLLBACK");
      lock.close();
    }
  },
);
