import { it, expect } from "vitest";
import {
  compareBacktests,
  modelQuote,
  modelCosts,
  summarize,
  type ComparisonInput,
  type Dependencies,
} from "../packages/backtest-engine/src/index.ts";
import {
  defaults,
  SUI,
  USDC,
  type Candle,
  type TradingDecision,
  type QuoteResult,
} from "../packages/shared/src/index.ts";
import {
  PaperTrading,
  initialPortfolio,
} from "../packages/paper-trading/src/index.ts";
import { evaluateSell } from "../packages/profit-guard/src/index.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  savedComparison,
  backtestMetadata,
} from "../apps/worker/src/backtest-service.ts";

const start = 1800000000;
const history = (): Candle[] =>
  Array.from({ length: 100 }, (_, i) => ({
    timestamp: start + i * 300,
    timeframe: 300,
    source: "SYNTHETIC_TEST",
    open: 2,
    close: 2,
    high: 2.01,
    low: 1.99,
    volume: 100000,
  }));
const options: ComparisonInput = {
  start: start + 65 * 300,
  end: start + 99 * 300,
  trainEnd: start + 64 * 300,
};
const decision = (
  action: TradingDecision["action"],
  purpose: TradingDecision["sellPurpose"] = "TAKE_PROFIT",
): TradingDecision => ({
  action,
  sellPurpose: purpose,
  confidence: 1,
  reason: "TEST",
  timestamp: new Date(start * 1000).toISOString(),
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
});
const buy: Dependencies = {
  strategyFactory: () => ({ analyze: async () => decision("BUY") }),
};
const cycle: Dependencies = {
  strategyFactory: () => ({
    analyze: async (c) =>
      decision(c.entryPrice === null ? "BUY" : "SELL", "STOP_LOSS"),
  }),
};

it("ON rejects insufficient projected BUY profit while OFF retains safety checks", async () => {
  const result = await compareBacktests(history(), options, defaults, buy);
  expect(result.on.summary.tradeCount).toBe(0);
  expect(result.on.summary.profitWaitCount).toBeGreaterThan(0);
  expect(result.off.summary.buyCount).toBeGreaterThan(0);
});
it("ON blocks insufficient TAKE_PROFIT and preserves losing STOP_LOSS", async () => {
  const profitableBase = { ...defaults, takeProfitPct: 0.3 };
  const tp = await compareBacktests(history(), options, profitableBase, {
    strategyFactory: () => ({
      analyze: async (c) => decision(c.entryPrice === null ? "BUY" : "SELL"),
    }),
  });
  expect(tp.on.summary.buyCount).toBeGreaterThan(0);
  expect(tp.on.summary.sellCount).toBe(0);
  expect(
    tp.on.events.some((e) => e.profit?.reason === "MINIMUM_NET_PROFIT_NOT_MET"),
  ).toBe(true);
  const stop = await compareBacktests(
    history(),
    options,
    profitableBase,
    cycle,
  );
  expect(stop.on.summary.sellCount).toBeGreaterThan(0);
  expect(
    stop.on.events
      .filter((e) => e.trade?.side === "SELL")
      .every((e) => e.trade!.pnl! < 0),
  ).toBe(true);
});
it.each(["expired", "invalid"] as const)(
  "rejects %s stop-loss quotes in both modes",
  async (mode) => {
    const result = await compareBacktests(
      history(),
      options,
      { ...defaults, takeProfitPct: 0.3 },
      {
        ...cycle,
        quoteFactory: (...args) => {
          const q = modelQuote(...args);
          if (args[0].from === SUI && args[1] > options.start * 1000)
            return mode === "expired"
              ? { ...q, createdAt: q.createdAt - 15000, expiresAt: q.createdAt }
              : { ...q, minAmountOut: "999999999999" };
          return q;
        },
      },
    );
    // The first BUY has valid quotes; every later protective SELL is rejected.
    expect(result.off.summary.sellCount).toBe(0);
    expect(result.on.summary.sellCount).toBe(0);
    expect(result.on.summary.buyCount).toBe(1);
    expect(result.off.summary.safetyRejectCount).toBeGreaterThan(0);
  },
);
it("rejects unknown gas in ON and OFF", async () => {
  const r = await compareBacktests(
    history(),
    { ...options, gasUsdc: null },
    defaults,
    buy,
  );
  expect(r.on.summary.tradeCount + r.off.summary.tradeCount).toBe(0);
  expect(r.off.summary.safetyRejectCount).toBeGreaterThan(0);
});
it("uses next open, completed history, previous volume, and no current high/low/volume for execution", async () => {
  const c = history();
  c[65] = { ...c[65], open: 2.1, high: 2.2, close: 2.1, volume: 0 };
  const seen: number[] = [];
  const r = await compareBacktests(c, options, defaults, {
    strategyFactory: () => ({
      analyze: async (ctx) => {
        expect(
          ctx.candles.every(
            (x) => (x.timestamp + x.timeframe) * 1000 <= ctx.now,
          ),
        ).toBe(true);
        seen.push(ctx.candles.at(-1)!.timestamp);
        return decision("BUY");
      },
    }),
  });
  const first = r.off.events[0];
  expect(first.quote?.referencePrice).toBe(2.1);
  expect(first.trade).not.toBeNull();
  expect(first.timestamp - first.signalTimestamp).toBe(300000);
  const altered = history();
  altered[65] = { ...c[65], high: 2.3, low: 1.8, close: 1.9, volume: 99999999 };
  const b = await compareBacktests(altered, options, defaults, buy);
  expect(b.off.events[0].quote).toEqual(first.quote);
  expect(b.off.events[0].trade).toEqual(first.trade);
  expect(seen.length).toBeGreaterThan(0);
});
it("is deterministic and ON/OFF portfolios are independent", async () => {
  const c = history(),
    base = structuredClone(defaults),
    o = structuredClone(options);
  const a = await compareBacktests(c, o, base, buy),
    b = await compareBacktests(c, o, base, buy);
  expect(a).toEqual(b);
  expect(c).toEqual(history());
  expect(base).toEqual(defaults);
  expect(o).toEqual(options);
  expect(a.on.portfolio).not.toBe(a.off.portfolio);
  a.off.portfolio.usdc = 0;
  expect(a.on.portfolio.usdc).toBe(100);
});
it("rejects duplicate timestamps, gaps, mixed data and inadequate warmup", async () => {
  const c = history();
  c[66] = { ...c[65] };
  await expect(compareBacktests(c, options)).rejects.toThrow();
  await expect(
    compareBacktests(history(), {
      ...options,
      start: start + 40 * 300,
      trainEnd: start + 39 * 300,
    }),
  ).rejects.toThrow("WARMUP");
  const mixed = history();
  mixed[90].source = "other";
  await expect(compareBacktests(mixed, options)).rejects.toThrow(
    "MIXED_DATA_SOURCES",
  );
});
it("rejects insufficient funds and never fills twice at one candle timestamp", async () => {
  const r = await compareBacktests(
    history(),
    { ...options, initialUsdc: 1 },
    defaults,
    buy,
  );
  expect(r.off.summary.tradeCount).toBe(0);
  expect(
    r.off.events.some((e) => e.reasons.includes("INSUFFICIENT_BALANCE")),
  ).toBe(true);
  const good = await compareBacktests(history(), options, defaults, cycle);
  const times = good.off.events.filter((e) => e.trade).map((e) => e.timestamp);
  expect(new Set(times).size).toBe(times.length);
});
it("uses PAPER accounting and does not add embedded DEX fees twice", async () => {
  const r = await compareBacktests(history(), options, defaults, buy),
    e = r.off.events.find((e) => e.trade)!;
  const s = { ...r.settings, profitGuardEnabled: false };
  const expected = new PaperTrading().fill(
    e.trade!.orderId,
    "BUY",
    e.quote!,
    initialPortfolio(e.timestamp, 100),
    s,
    e.timestamp,
  );
  expect(e.trade).toEqual(expected.trade);
  expect(e.trade!.acquisition!.totalCostUsdc).toBe("5.030000");
  expect(r.off.summary.dexFees).toBeGreaterThan(0);
});
it("allocates partial SELL basis exactly with shared PAPER accounting", () => {
  const s = { ...defaults, feeRate: 0 },
    paper = new PaperTrading();
  const q: QuoteResult = modelQuote(
    {
      from: USDC,
      to: SUI,
      amountIn: "5000000",
      slippage: 0,
      referencePrice: 2,
    },
    start * 1000,
    100000,
    { spread: 0, impact: 0, dexFeeRate: 0, participation: 0.001 },
  );
  const b = paper.fill(
    "b",
    "BUY",
    q,
    initialPortfolio(start * 1000),
    s,
    start * 1000,
  );
  const sell = modelQuote(
    {
      from: SUI,
      to: USDC,
      amountIn: "1000000000",
      slippage: 0,
      referencePrice: 2,
    },
    start * 1000,
    100000,
    { spread: 0, impact: 0, dexFeeRate: 0, participation: 0.001 },
  );
  const o = { ...rOptions(), additionalFeeRate: 0 };
  const report = evaluateSell({
    position: {
      quantityAtomic: b.portfolio.quantityAtomic!,
      costUsdc: b.portfolio.costBasisUsdc!,
    },
    quote: sell,
    costs: modelCosts(sell, o),
    purpose: "STOP_LOSS",
    config: {
      enabled: true,
      minProfitUsdc: "0.05",
      minProfitPct: "0.01",
      targetProfitPct: "0.04",
    },
    now: start * 1000,
  });
  expect(report.allowed).toBe(true);
  expect(report.allocatedCostUsdc).toBe("2.012000");
  const fill = paper.fill("s", "SELL", sell, b.portfolio, s, start * 1000);
  expect(fill.trade.allocatedCostUsdc).toBe("2.012000");
  expect(fill.portfolio.costBasisUsdc).toBe("3.018000");
});
function rOptions() {
  return {
    ...options,
    initialUsdc: 100,
    maxOrder: 5,
    slippage: 0.003,
    spread: 0.001,
    impact: 0.001,
    dexFeeRate: 0.003,
    additionalFeeRate: 0,
    gasUsdc: 0.03,
    participation: 0.001,
    minNetProfitUsdc: 0.05,
    minNetProfitPct: 0.01,
  };
}
it("permits TAKE_PROFIT once actual modeled net proceeds meet both thresholds", async () => {
  const c = history();
  for (let i = 66; i < c.length; i++)
    c[i] = { ...c[i], open: 2.2, close: 2.2, high: 2.21, low: 2.19 };
  const result = await compareBacktests(
    c,
    options,
    { ...defaults, takeProfitPct: 0.3 },
    {
      strategyFactory: () => ({
        analyze: async (ctx) =>
          decision(ctx.entryPrice === null ? "BUY" : "SELL", "TAKE_PROFIT"),
      }),
    },
  );
  expect(
    result.on.events.some(
      (e) =>
        e.trade?.side === "SELL" &&
        e.profit?.reason === "MINIMUM_NET_PROFIT_MET",
    ),
  ).toBe(true);
});
it("does not execute a signal that requires the final candle's close", async () => {
  const r = await compareBacktests(history(), options, defaults, {
    strategyFactory: () => ({
      analyze: async (ctx) =>
        decision(ctx.candles.length >= 100 ? "BUY" : "WAIT"),
    }),
  });
  expect(r.off.summary.tradeCount).toBe(0);
  expect(r.on.summary.tradeCount).toBe(0);
});
it("retains daily buy and holding limits even with Profit Guard OFF", async () => {
  const r = await compareBacktests(history(), options, defaults, buy);
  expect(
    r.off.events.some(
      (e) =>
        e.reasons.includes("DAILY_BUY_LIMIT") ||
        e.reasons.includes("MAX_HOLDING"),
    ),
  ).toBe(true);
  expect(r.off.summary.buyCount).toBeLessThanOrEqual(4);
});
it("keeps report persistence isolated from PAPER runtime, portfolio, settings and trade history", async () => {
  const db = new BotDatabase(":memory:");
  try {
    db.saveCandles(history());
    const before = {
      p: db.portfolio(),
      s: db.settings(),
      r: db.runtime(),
      trades: db.history("paper_trades"),
    };
    const report = await savedComparison(db, options);
    expect({
      p: db.portfolio(),
      s: db.settings(),
      r: db.runtime(),
      trades: db.history("paper_trades"),
    }).toEqual(before);
    expect(db.history("backtest_runs")).toHaveLength(1);
    expect(backtestMetadata(db).count).toBe(100);
    expect(report.history).toEqual(history());
    const replay = await compareBacktests(
      report.history,
      report.options,
      report.settings,
    );
    expect(replay).toEqual(report);
  } finally {
    db.close();
  }
});
it("computes drawdown and handles zero trades and zero division", () => {
  const p = initialPortfolio(start * 1000, 100);
  p.usdc = 90;
  const curve = [100, 120, 90].map((equity, i) => ({
    timestamp: i,
    price: 2,
    equity,
    drawdown: 0,
  }));
  const result = summarize(100, p, 2, curve, []);
  expect(result.maxDrawdown).toBe(0.25);
  expect(result.winRate).toBe(0);
  expect(result.profitFactor).toBeNull();
  expect(result.averageLoss).toBeNull();
  expect(result.tradeCount).toBe(0);
  expect(result.totalGas).toBe(0);
});
