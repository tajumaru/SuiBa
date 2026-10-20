import { describe, it, expect } from "vitest";
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
import { BotEngine } from "../apps/worker/src/engine.ts";
import type { DexRouter } from "../packages/shared/src/index.ts";
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
  it("charges worst slippage, gas and fees; round trip conserves equity accounting", () => {
    const exec = new PaperTrading(),
      p = initialPortfolio(now);
    const b = exec.fill("b", "BUY", quote, p, defaults, now);
    expect(b.portfolio.usdc).toBeCloseTo(94.955);
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
  function setup(onQuote?: (db: BotDatabase) => void) {
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
    const router: DexRouter = {
      getQuote: async (request) => {
        calls++;
        onQuote?.(db);
        return {
          ...quote,
          ...request,
          amountOut: "2000000",
          minAmountOut: "1994000",
          createdAt: Date.now(),
          expiresAt: Date.now() + 15000,
        };
      },
      validateQuote: async () => true,
    };
    const engine = new BotEngine(db, { candles: async () => c }, router, {
      health: async () => ({
        healthy: true,
        checkedAt: Date.now(),
        failures: 0,
      }),
      status: { healthy: true, checkedAt: Date.now(), failures: 0 },
    });
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
  it("serializes ticks and processes each closed candle at most once", async () => {
    const t = setup();
    await Promise.all([t.engine.tick(), t.engine.tick()]);
    await t.engine.tick();
    expect(t.calls()).toBe(1);
    expect(t.db.history("paper_trades")).toHaveLength(1);
    t.db.close();
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
