import {
  atomic,
  SUI,
  USDC,
  dayKey,
  defaults,
  type Candle,
  type Settings,
  type QuoteResult,
  type TradingStrategy,
} from "../../shared/src/index.ts";
import { calculate } from "../../indicators/src/index.ts";
import { RuleBasedStrategy } from "../../strategy-engine/src/index.ts";
import { assessRisk } from "../../risk-engine/src/index.ts";
import { equity, metrics } from "../../portfolio/src/index.ts";
import { PaperTrading, initialPortfolio, type Fill } from "./index.ts";
export interface BacktestOptions {
  trainEnd: number;
  testStart: number;
  testEnd: number;
  participation: number;
  impact: number;
}
export async function backtest(
  c: Candle[],
  o: BacktestOptions,
  s: Settings = defaults,
  strategy: TradingStrategy = new RuleBasedStrategy(s),
) {
  if (
    o.testStart <= o.trainEnd ||
    o.testEnd <= o.testStart ||
    o.participation <= 0 ||
    o.participation > 0.01 ||
    o.impact < 0 ||
    o.impact > s.maxSlippage
  )
    throw new Error("INVALID_BACKTEST_SPLIT");
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    if (
      ![x.open, x.high, x.low, x.close, x.volume, x.timestamp].every(
        Number.isFinite,
      ) ||
      Math.min(x.open, x.high, x.low, x.close) <= 0 ||
      x.volume < 0 ||
      x.timestamp % x.timeframe !== 0 ||
      x.high < Math.max(x.open, x.close) ||
      x.low > Math.min(x.open, x.close) ||
      (i && x.timestamp - c[i - 1].timestamp !== x.timeframe)
    )
      throw new Error("INVALID_HISTORY");
  }
  const first = c.findIndex((x) => x.timestamp >= o.testStart);
  if (first < 62) throw new Error("INSUFFICIENT_WARMUP");
  let p = initialPortfolio(o.testStart * 1000),
    entryAt: number | null = null;
  const trades: Fill[] = [],
    values = [p.initialEquity],
    holds: number[] = [],
    returns: number[] = [];
  const executor = new PaperTrading();
  let pending: "BUY" | "SELL" | "WAIT" = "WAIT",
    rejections = 0;
  const test = c.filter(
    (x) => x.timestamp >= o.testStart && x.timestamp <= o.testEnd,
  );
  if (test.length < 2) throw new Error("INSUFFICIENT_TEST_DATA");
  for (let i = first; i < c.length && c[i].timestamp <= o.testEnd; i++) {
    const bar = c[i],
      now = bar.timestamp * 1000,
      price = bar.open;
    if (p.day !== dayKey(now))
      p = {
        ...p,
        day: dayKey(now),
        dailyBought: 0,
        dayStartEquity: equity(p, price),
      };
    // Decision made after the prior close; model execution at next open, never same-bar close.
    if (pending !== "WAIT") {
      const side = pending,
        amount =
          side === "BUY" ? s.maxOrder : Math.min(p.sui, s.maxOrder / price),
        input = atomic(amount, side === "BUY" ? USDC : SUI),
        out =
          side === "BUY"
            ? (amount / price) * (1 - o.impact)
            : amount * price * (1 - o.impact);
      const q: QuoteResult = {
        id: `history:${bar.timestamp}`,
        from: side === "BUY" ? USDC : SUI,
        to: side === "BUY" ? SUI : USDC,
        amountIn: input,
        amountOut: atomic(out, side === "BUY" ? SUI : USDC),
        minAmountOut: atomic(
          out * (1 - s.maxSlippage),
          side === "BUY" ? SUI : USDC,
        ),
        slippage: s.maxSlippage,
        referencePrice: price,
        priceImpact: o.impact,
        liquid: true,
        createdAt: now,
        expiresAt: now + 15000,
        route: ["historical-cost-model"],
        source: "MODEL: historical routes unavailable",
      };
      const reasons = assessRisk({
        side,
        quote: q,
        portfolio: p,
        runtime: {
          running: true,
          emergency: false,
          error: null,
          lastCandle: null,
        },
        settings: s,
        price,
        marketClosedAt: now,
        now,
        duplicate: false,
        pending: 0,
      });
      // Use only previous candle volume for participation: current volume is future information.
      if (
        amount <= 0 ||
        amount * (side === "SELL" ? price : 1) >
          c[i - 1].volume * o.participation
      )
        reasons.push("HISTORICAL_LIQUIDITY_LIMIT");
      if (!reasons.length) {
        const result = executor.fill(q.id, side, q, p, s, now);
        p = result.portfolio;
        trades.push(result.trade);
        if (side === "BUY" && entryAt === null) entryAt = now;
        if (side === "SELL" && p.sui < 1e-8 && entryAt !== null) {
          holds.push(now - entryAt);
          entryAt = null;
        }
      } else rejections++;
    }
    const slice = c.slice(0, i + 1),
      current = calculate(slice),
      previous = calculate(slice.slice(0, -1));
    pending = (
      await strategy.analyze({
        candles: slice,
        current,
        previous,
        entryPrice: p.sui ? p.costBasis / p.sui : null,
        now: (bar.timestamp + bar.timeframe) * 1000,
      })
    ).action;
    const v = equity(p, bar.close);
    returns.push(v / values.at(-1)! - 1);
    values.push(v);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length,
    sd = Math.sqrt(
      returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length,
    );
  const final = values.at(-1)!;
  return {
    model:
      "next-open + fixed impact + worst slippage + fee + gas; NOT historical executable DEX quotes",
    split: o,
    settings: s,
    initialEquity: p.initialEquity,
    finalEquity: final,
    pnl: final - p.initialEquity,
    ...metrics(
      values,
      trades.flatMap((t) => (t.pnl === null ? [] : [t.pnl])),
    ),
    sharpe: sd ? (mean / sd) * Math.sqrt((365 * 86400) / c[0].timeframe) : null,
    tradeCount: trades.length,
    rejections,
    averageHoldingMs: holds.length
      ? holds.reduce((a, b) => a + b, 0) / holds.length
      : null,
    fees: p.fees,
    buyAndHoldPnl:
      (p.initialEquity /
        (test[0].open * (1 + s.feeRate + s.maxSlippage + o.impact))) *
        test.at(-1)!.close *
        (1 - s.feeRate - s.maxSlippage - o.impact) -
      2 * s.gasUsdc -
      p.initialEquity,
    trades,
  };
}
