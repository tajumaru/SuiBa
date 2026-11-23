import { describe, it, expect, vi } from "vitest";
import { ema, rsi, calculate } from "../packages/indicators/src/index.ts";
import {
  coin,
  SUI,
  USDC,
  defaults,
  atomic,
  type Candle,
  type QuoteResult,
} from "../packages/shared/src/index.ts";
import {
  assessRisk,
  type RiskInput,
} from "../packages/risk-engine/src/index.ts";
import {
  PaperTrading,
  initialPortfolio,
} from "../packages/paper-trading/src/index.ts";
import { validateCandles } from "../packages/market-data/src/index.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { backtest } from "../packages/paper-trading/src/backtest.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import { buildDiagnosticReport } from "../apps/dashboard/src/diagnosticExport.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import type { DexRouter } from "../packages/shared/src/index.ts";
import type { ExecutionAdapter } from "../apps/worker/src/execution-adapter.ts";
const now = 1800000000000;
const quote: QuoteResult = {
  id: "q",
  from: USDC,
  to: SUI,
  amountIn: "5000000",
  amountOut: "2500000000",
  minAmountOut: "2492500000",
  slippage: 0.003,
  referencePrice: 2,
  priceImpact: 0.001,
  liquid: true,
  createdAt: now,
  expiresAt: now + 15000,
  route: ["CETUS"],
  source: "test",
};
const risk = (): RiskInput => ({
  side: "BUY",
  quote: { ...quote },
  portfolio: initialPortfolio(now),
  runtime: { running: true, emergency: false, error: null, lastCandle: null },
  settings: { ...defaults },
  price: 2,
  marketClosedAt: now,
  now,
  duplicate: false,
  pending: 0,
});
function candles(count = 250): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1799900100 + i * 300,
    open: 2,
    high: 2.1,
    low: 1.9,
    close: 2,
    volume: 100000,
    source: "fixture",
    timeframe: 300,
  }));
}
describe("independent indicator fixtures", () => {
  it("SMA seeded EMA matches hand calculation", () =>
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]));
  it("Wilder RSI published worksheet initial value", () =>
    expect(
      rsi([
        44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08,
        45.89, 46.03, 45.61, 46.28, 46.28,
      ]),
    ).toBeCloseTo(70.4641, 4));
  it("constant prices yield neutral RSI, zero MACD and known ATR", () => {
    const x = calculate(candles());
    expect(x.rsi).toBe(50);
    expect(x.macd).toBe(0);
    expect(x.signal).toBe(0);
    expect(x.ema20).toBe(2);
    expect(x.ema50).toBe(2);
    expect(x.atr).toBeCloseTo(0.2);
    expect(x.priceChange).toBe(0);
  });
  it("MACD matches an independently computed fixture at two lengths", () => {
    // Fixed deterministic close series; expected values were computed
    // independently of this implementation (textbook MACD: SMA-seeded
    // EMA12/EMA26, signal = SMA-seeded EMA9 of the MACD line). Pins the
    // definition so a future refactor cannot drift silently.
    const closes = [
      102.4089, 103.8075, 104.3426, 104.2322, 103.8748, 103.6996, 104.0087,
      104.8657, 106.0675, 107.2107, 107.8283, 107.5535, 106.2518, 104.0795,
      101.4471, 98.8984, 96.9466, 95.9202, 95.8708, 96.572, 97.609, 98.5289,
      98.9997, 98.9252, 98.4757, 98.0256, 98.0184, 98.8051, 100.5108, 102.9752,
      105.7883, 108.4092, 110.3299, 111.2296, 111.0684, 110.0894, 108.7299,
      107.4705, 106.6744, 106.4702, 106.7169, 107.064, 107.0838, 106.4326,
      104.9846, 102.8926, 100.5556, 98.5006, 97.2207, 97.0204, 97.9215, 99.6598,
      101.7738, 103.7554, 105.213, 105.991, 106.208, 106.1994, 106.3869,
      107.1179, 108.5301, 110.4883, 112.6152, 114.4059, 115.3891, 115.2814,
      114.0815, 112.0745, 109.744, 107.6201,
    ];
    const series = (n: number): Candle[] =>
      closes.slice(0, n).map((close, i) => ({
        timestamp: 1799900100 + i * 300,
        open: close,
        high: close + 0.1,
        low: close - 0.1,
        close,
        volume: 100000,
        source: "fixture",
        timeframe: 300,
      }));
    const at60 = calculate(series(60));
    expect(at60.macd).toBeCloseTo(0.5292253132, 6);
    expect(at60.signal).toBeCloseTo(-0.1605952894, 6);
    expect(at60.histogram).toBeCloseTo(0.6898206026, 6);
    const at70 = calculate(series(70));
    expect(at70.macd).toBeCloseTo(2.0343204474, 6);
    expect(at70.signal).toBeCloseTo(2.0646645184, 6);
    expect(at70.histogram).toBeCloseTo(-0.030344071, 6);
  });
  it("monotonic prices and decimal boundaries", () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(100);
    expect(atomic("0.000000001", SUI)).toBe("1");
  });
});
describe("fail-closed risk", () => {
  it("allows a small funded paper buy", () =>
    expect(assessRisk(risk())).toEqual([]));
  it.each([
    "stop",
    "emergency",
    "duplicate",
    "pending",
    "stale",
    "balance",
    "order",
    "loss",
    "daily",
    "holding",
    "slip",
    "impact",
    "liquidity",
    "expiry",
    "coin",
    "nan",
  ])("rejects %s", (kind) => {
    const x = risk();
    switch (kind) {
      case "stop":
        x.runtime.running = false;
        break;
      case "emergency":
        x.runtime.emergency = true;
        break;
      case "duplicate":
        x.duplicate = true;
        break;
      case "pending":
        x.pending = 1;
        break;
      case "stale":
        x.marketClosedAt -= 400000;
        break;
      case "balance":
        x.portfolio.usdc = 1;
        break;
      case "order":
        x.quote.amountIn = "6000000";
        break;
      case "loss":
        x.portfolio.dayStartEquity = 110;
        break;
      case "daily":
        x.portfolio.dailyBought = 20;
        break;
      case "holding":
        x.portfolio.sui = 20;
        break;
      case "slip":
        x.quote.slippage = 0.01;
        break;
      case "impact":
        x.quote.priceImpact = 0.1;
        break;
      case "liquidity":
        x.quote.liquid = false;
        break;
      case "expiry":
        x.now += 15000;
        break;
      case "coin":
        x.quote.to = "0xbad::sui::SUI";
        break;
      case "nan":
        x.price = NaN;
    }
    expect(assessRisk(x).length).toBeGreaterThan(0);
  });
  it("permits risk-reducing sale after daily loss stop", () => {
    const x = risk();
    x.side = "SELL";
    x.portfolio = { ...x.portfolio, sui: 2, dayStartEquity: 200 };
    x.quote = {
      ...quote,
      from: SUI,
      to: USDC,
      amountIn: "1000000000",
      amountOut: "2000000",
      minAmountOut: "1994000",
    };
    expect(assessRisk(x)).toEqual([]);
  });
  it("rejects spoofed token names", () =>
    expect(() => coin("0xbad::usdc::USDC")).toThrow());
});
describe("market validation", () => {
  it("requires contiguous completed candles", () => {
    const c = candles(70),
      time = (c.at(-1)!.timestamp + 300) * 1000;
    expect(validateCandles(c, 300, time)).toHaveLength(70);
    expect(() =>
      validateCandles(
        c.filter((_, i) => i !== 10),
        300,
        time,
      ),
    ).toThrow("GAP");
    expect(() => validateCandles(c, 300, time - 1)).toThrow("INVALID");
  });
});
describe("paper ledger and persistence", () => {
  it("charges modeled quote impact, gas and fees; round trip conserves equity accounting", () => {
    const exec = new PaperTrading(),
      p = initialPortfolio(now);
    const b = exec.fill("b", "BUY", quote, p, defaults, now);
    expect(b.portfolio.usdc).toBeCloseTo(94.99);
    expect(b.portfolio.sui).toBe(2.4925);
    const sell = {
      ...quote,
      from: SUI,
      to: USDC,
      amountIn: atomic(b.portfolio.sui, SUI),
      amountOut: "4985000",
      minAmountOut: "4970045",
    };
    const a = exec.fill("s", "SELL", sell, b.portfolio, defaults, now);
    expect(a.portfolio.sui).toBe(0);
    expect(a.portfolio.usdc - 100).toBeCloseTo(a.portfolio.realized);
    expect(a.portfolio.costBasis).toBe(0);
  });
  it("rolls back duplicate fill and persists emergency flag", () => {
    const db = new BotDatabase(":memory:");
    db.set("runtime", {
      running: true,
      emergency: false,
      error: null,
      lastCandle: null,
    });
    const f = new PaperTrading().fill(
      "order",
      "BUY",
      quote,
      db.portfolio(),
      defaults,
      now,
    );
    db.commitFill("order", {}, f.portfolio, f.trade, db.runtime());
    expect(() =>
      db.commitFill("order", {}, f.portfolio, f.trade, db.runtime()),
    ).toThrow("DUPLICATE");
    expect(db.history("paper_trades")).toHaveLength(1);
    db.set("runtime", { ...db.runtime(), emergency: true });
    expect(db.runtime().emergency).toBe(true);
    db.close();
  });
});
describe("strategy and historical chronology", () => {
  it("waits on flat prices", async () => {
    const c = candles();
    const decision = await new RuleBasedStrategy(defaults).analyze({
      candles: c,
      current: calculate(c),
      previous: calculate(c.slice(0, -1)),
      entryPrice: null,
      now,
    });
    expect(decision.action).toBe("WAIT");
  });
  it("executes prior decision at next open; requires disjoint test period", async () => {
    const c = candles(),
      o = {
        trainEnd: c[149].timestamp,
        testStart: c[150].timestamp,
        testEnd: c.at(-1)!.timestamp,
        participation: 0.001,
        impact: 0.001,
      };
    const strategy = {
      analyze: async () => ({
        action: "BUY" as const,
        confidence: 1,
        reason: "fixture",
        stopLossPct: null,
        takeProfitPct: null,
        timestamp: "",
      }),
    };
    const result = await backtest(c, o, defaults, strategy);
    expect(result.trades[0].timestamp).toBe(c[151].timestamp * 1000);
    expect(result.fees).toBeGreaterThan(0);
    await expect(backtest(c, { ...o, trainEnd: o.testStart })).rejects.toThrow(
      "SPLIT",
    );
  });
  it("future prices cannot change earlier fills", async () => {
    const c = candles();
    const o = {
      trainEnd: c[149].timestamp,
      testStart: c[150].timestamp,
      testEnd: c.at(-1)!.timestamp,
      participation: 0.001,
      impact: 0.001,
    };
    const strat = {
      analyze: async () => ({
        action: "BUY" as const,
        confidence: 1,
        reason: "fixture",
        stopLossPct: null,
        takeProfitPct: null,
        timestamp: "",
      }),
    };
    const a = await backtest(c, o, defaults, strat);
    const b = await backtest(
      c.map((x, i) =>
        i < 200 ? x : { ...x, open: 3, close: 3, high: 3.1, low: 2.9 },
      ),
      o,
      defaults,
      strat,
    );
    expect(
      a.trades.filter((t) => t.timestamp < c[200].timestamp * 1000),
    ).toEqual(b.trades.filter((t) => t.timestamp < c[200].timestamp * 1000));
  });
});

describe("worker execution boundaries", () => {
  function setup(
    onQuote?: (db: BotDatabase) => void,
    onValidate?: (db: BotDatabase, call: number, q: QuoteResult) => void,
    executionAdapter?: ExecutionAdapter,
  ) {
    const db = new BotDatabase(":memory:");
    db.set("runtime", {
      running: true,
      emergency: false,
      error: null,
      lastCandle: null,
    });
    db.set("portfolio", { ...initialPortfolio(), sui: 1, costBasis: 0.5 });
    const timestamp = Math.floor(Date.now() / 300000) * 300 - 300;
    const c = candles(70).map((x, i) => ({
      ...x,
      timestamp: timestamp - (69 - i) * 300,
    }));
    let calls = 0;
    let validations = 0;
    const router: DexRouter = {
      getQuote: async (request) => {
        calls++;
        onQuote?.(db);
        // One timestamp for both fields: two Date.now() calls can
        // straddle a millisecond boundary and stamp a 15,001 ms
        // lifetime, which the profit guard rightly rejects as an
        // invalid quote — a flake that once surfaced as
        // PROFIT_GUARD_INVALID_QUOTE instead of MAX_ORDER.
        const at = Date.now();
        return {
          ...quote,
          ...request,
          amountOut: "2000000",
          minAmountOut: "1994000",
          createdAt: at,
          expiresAt: at + 15000,
        };
      },
      validateQuote: async (q) => {
        onValidate?.(db, ++validations, q);
        return true;
      },
    };
    const engine = new BotEngine(
      db,
      { candles: async () => c },
      router,
      {
        health: async () => ({
          healthy: true,
          checkedAt: Date.now(),
          failures: 0,
        }),
        status: { healthy: true, checkedAt: Date.now(), failures: 0 },
      },
      "SUI_USDC",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      executionAdapter,
    );
    return { db, engine, calls: () => calls };
  }
  it("blocks a quote that was in flight when emergency stop was pressed", async () => {
    const t = setup((db) =>
      db.set("runtime", { ...db.runtime(), emergency: true, running: false }),
    );
    await t.engine.tick();
    expect(t.calls()).toBe(1);
    expect(t.db.history("paper_trades")).toHaveLength(0);
    expect(t.db.runtime().emergency).toBe(true);
    t.db.close();
  });
  it("applies settings tightened while a quote was in flight", async () => {
    const t = setup((db) =>
      db.updateSettings({ ...db.settings(), maxOrder: 1 }),
    );
    await t.engine.tick();
    expect(t.db.history("paper_trades")).toHaveLength(0);
    expect(JSON.stringify(t.db.history("risk_events"))).toContain("MAX_ORDER");
    t.db.close();
  });
  it.each([false, true])(
    "rechecks stop/emergency=%s after the final async quote validation",
    async (emergency) => {
      const t = setup(undefined, (db, call) => {
        if (call === 3)
          db.set("runtime", { ...db.runtime(), running: false, emergency });
      });
      await t.engine.tick();
      expect(t.db.history("paper_trades")).toHaveLength(0);
      expect(t.db.runtime()).toMatchObject({
        running: false,
        emergency,
        error: null,
      });
      t.db.close();
    },
  );
  it("rejects a quote that expires during final validation even if the router returns true", async () => {
    const t = setup(undefined, (_, call, q) => {
      if (call === 3) q.expiresAt = Date.now() - 1;
    });
    await t.engine.tick();
    expect(t.db.history("paper_trades")).toHaveLength(0);
    expect(t.db.runtime().error).toBe("QUOTE_EXPIRED");
    t.db.close();
  });
  it("serializes ticks and processes each closed candle at most once", async () => {
    const t = setup();
    await Promise.all([t.engine.tick(), t.engine.tick()]);
    await t.engine.tick();
    expect(t.calls()).toBe(1);
    expect(t.db.history("paper_trades")).toHaveLength(1);
    t.db.close();
  });
  it("routes an approved REAL decision to the execution adapter without a PAPER fill", async () => {
    const intents: unknown[] = [];
    const adapter: ExecutionAdapter = {
      kind: "REAL_TRADECAP",
      feeEstimate: async (_side, epoch) => ({
        takerFee: 0.001,
        source: "POOL_ACTUAL",
        stale: false,
        epoch,
        readAt: Date.now(),
      }),
      acceptStop: () => undefined,
      recordEngineChecks: () => undefined,
      execute: async (intent) => {
        intents.push(intent);
        return { status: "SUBMITTED", digest: "real-digest" };
      },
    };
    const t = setup(undefined, undefined, adapter);
    await t.engine.tick();
    expect(intents).toHaveLength(1);
    expect(t.db.history("paper_trades")).toHaveLength(0);
    expect(
      t.db
        .history<{ outcome: string }>("cycle_audits")
        .some((row) => row.outcome === "REAL_SUBMITTED"),
    ).toBe(true);
    t.db.close();
  });
  it("fails a REAL BUY closed when the first fee read is unavailable", async () => {
    const execute = vi.fn();
    const adapter: ExecutionAdapter = {
      kind: "REAL_TRADECAP",
      feeEstimate: async (_side, epoch) => ({
        takerFee: null,
        source: "UNAVAILABLE",
        stale: true,
        epoch,
        readAt: null,
      }),
      acceptStop: () => undefined,
      recordEngineChecks: () => undefined,
      execute,
    };
    const analyze = vi
      .spyOn(RuleBasedStrategy.prototype, "analyze")
      .mockResolvedValue({
        action: "BUY",
        confidence: 0.8,
        reason: "fixture buy",
        stopLossPct: 0.02,
        takeProfitPct: 0.04,
        timestamp: new Date().toISOString(),
      });
    const t = setup(undefined, undefined, adapter);
    t.db.set("portfolio", initialPortfolio());
    try {
      await t.engine.tick();
      expect(execute).not.toHaveBeenCalled();
      expect(t.db.history("paper_trades")).toHaveLength(0);
      expect(
        t.db.history<{
          side: string;
          finalAction: string;
          feeSource: string;
          feeParamsStale: boolean;
          profitGuard: { allowed: boolean; reason: string };
        }>("operation_candidates")[0],
      ).toMatchObject({
        side: "BUY",
        finalAction: "WAIT",
        feeSource: "UNAVAILABLE",
        feeParamsStale: true,
        profitGuard: { allowed: false, reason: "PROFIT_DATA_UNKNOWN" },
      });
    } finally {
      analyze.mockRestore();
      t.db.close();
    }
  });
  it("allows a REAL SELL with the delegated 10 bps fallback and audits it", async () => {
    const execute = vi.fn(async () => ({
      status: "SUBMITTED" as const,
      digest: "real-fallback-digest",
    }));
    const adapter: ExecutionAdapter = {
      kind: "REAL_TRADECAP",
      feeEstimate: async (_side, epoch) => ({
        takerFee: 0.001,
        source: "DESIGN_ASSUMPTION",
        stale: true,
        epoch,
        readAt: null,
      }),
      acceptStop: () => undefined,
      recordEngineChecks: () => undefined,
      execute,
    };
    const t = setup(undefined, undefined, adapter);
    await t.engine.tick();
    expect(execute).toHaveBeenCalledOnce();
    expect(t.db.history("paper_trades")).toHaveLength(0);
    expect(
      t.db.history<{
        side: string;
        finalAction: string;
        feeRate: number;
        feeSource: string;
        feeParamsStale: boolean;
      }>("operation_candidates")[0],
    ).toMatchObject({
      side: "SELL",
      finalAction: "SELL",
      feeRate: 0.001,
      feeSource: "DESIGN_ASSUMPTION",
      feeParamsStale: true,
    });
    t.db.close();
  });
  it("persists and exports scrubbed detail for an unclassified execution failure", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Submission rejected https://example.invalid token=private", {
        cause: new Error("Transaction expired"),
      });
    });
    const adapter: ExecutionAdapter = {
      kind: "REAL_TRADECAP",
      feeEstimate: async (_side, epoch) => ({
        takerFee: 0.001,
        source: "DESIGN_ASSUMPTION",
        stale: true,
        epoch,
        readAt: null,
      }),
      acceptStop: () => undefined,
      recordEngineChecks: () => undefined,
      execute,
    };
    const { db, engine } = setup(undefined, undefined, adapter);
    try {
      await engine.tick();
      expect(execute).toHaveBeenCalledOnce();
      const failureDetail =
        "Submission rejected token=[redacted] | cause: Transaction expired";
      expect(db.history("operation_candidates")[0]).toMatchObject({
        finalAction: "SAFE_STOP",
        reasons: ["DATA_OR_EXECUTION_FAILURE"],
        failureDetail,
      });
      expect(db.history("cycle_audits")).toContainEqual(
        expect.objectContaining({
          phase: "END",
          error: "DATA_OR_EXECUTION_FAILURE",
          failureDetail,
        }),
      );
      expect(buildDiagnosticReport(engine.monitor.snapshot())).toContain(
        `SAFE_STOP DATA_OR_EXECUTION_FAILURE — failureDetail: ${failureDetail}`,
      );
    } finally {
      db.close();
    }
  });
  it("fails safely on upstream error", async () => {
    const db = new BotDatabase(":memory:");
    db.set("runtime", { ...db.runtime(), running: true });
    const engine = new BotEngine(
      db,
      {
        candles: async () => {
          throw new Error("contains hypothetical secret");
        },
      },
      { getQuote: async () => quote, validateQuote: async () => true },
      {
        health: async () => ({ healthy: true, checkedAt: 0, failures: 0 }),
        status: { healthy: true, checkedAt: 0, failures: 0 },
      },
    );
    await engine.tick();
    expect(db.runtime().running).toBe(false);
    expect(db.runtime().error).toBe("DATA_OR_EXECUTION_FAILURE");
    expect(JSON.stringify(db.history("risk_events"))).not.toContain(
      "hypothetical secret",
    );
    db.close();
  });
});
