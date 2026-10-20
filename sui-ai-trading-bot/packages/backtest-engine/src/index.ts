import { z } from "zod";
import {
  Decimal,
  atomic,
  units,
  SUI,
  USDC,
  dayKey,
  defaults,
  settingsSchema,
  profitConfigOf,
  type Settings,
  type Candle,
  type QuoteRequest,
  type QuoteResult,
  type TradingDecision,
  type TradingStrategy,
  type Portfolio,
} from "../../shared/src/index.ts";
import { calculate } from "../../indicators/src/index.ts";
import { validateCandles } from "../../market-data/src/index.ts";
import { RuleBasedStrategy } from "../../strategy-engine/src/index.ts";
import { assessRisk } from "../../risk-engine/src/index.ts";
import {
  evaluateBuy,
  evaluateSell,
  positionOf,
  strategyExitPrice,
  expense,
  type Costs,
  type ProfitReport,
} from "../../profit-guard/src/index.ts";
import {
  PaperTrading,
  initialPortfolio,
  type Fill,
} from "../../paper-trading/src/index.ts";
import { equity, metrics } from "../../portfolio/src/index.ts";

const rate = z.number().finite().min(0).max(0.01);
export const comparisonOptionsSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    trainEnd: z.number().int().nonnegative(),
    initialUsdc: z.number().finite().positive().max(1000000).default(100),
    maxOrder: z.number().positive().max(5).default(5),
    slippage: z.number().min(0).max(0.003).default(0.003),
    spread: rate.default(0.001),
    impact: z.number().min(0).max(0.003).default(0.001),
    dexFeeRate: rate.default(0.003),
    additionalFeeRate: rate.default(0),
    gasUsdc: z.number().positive().max(1).nullable().default(0.03),
    participation: z.number().positive().max(0.01).default(0.001),
    minNetProfitUsdc: z.number().min(0).max(5).default(0.05),
    minNetProfitPct: z.number().min(0).max(1).default(0.01),
  })
  .strict()
  .refine(
    (v) => v.trainEnd < v.start && v.start < v.end,
    "INVALID_PERIOD_SPLIT",
  );
export type ComparisonOptions = z.infer<typeof comparisonOptionsSchema>;
export type ComparisonInput = z.input<typeof comparisonOptionsSchema>;
export type CostModel = Pick<
  ComparisonOptions,
  "spread" | "impact" | "dexFeeRate" | "participation"
>;
const D = Decimal.clone({ precision: 60 });

// No network: both directions degrade fair output by identical configured cost factors.
export function modelQuote(
  request: QuoteRequest,
  now: number,
  previousVolume: number,
  model: CostModel,
): QuoteResult {
  const buy = request.from === USDC && request.to === SUI;
  if (!buy && !(request.from === SUI && request.to === USDC))
    throw new Error("INVALID_QUOTE_DIRECTION");
  if (
    !Number.isFinite(request.referencePrice) ||
    request.referencePrice <= 0 ||
    !/^\d+$/.test(request.amountIn) ||
    BigInt(request.amountIn) <= 0n
  )
    throw new Error("INVALID_MODEL_INPUT");
  const input = new D(request.amountIn).div(buy ? 1e6 : 1e9);
  const gross = buy
    ? input.div(request.referencePrice)
    : input.mul(request.referencePrice);
  const beforeFee = gross
    .mul(new D(1).minus(model.spread))
    .mul(new D(1).minus(model.impact));
  const output = beforeFee.mul(new D(1).minus(model.dexFeeRate));
  const notional = buy ? input : input.mul(request.referencePrice);
  return {
    ...request,
    id: `model:${now}:${request.from}:${request.amountIn}`,
    amountOut: atomic(output.toString(), request.to),
    minAmountOut: atomic(
      output.mul(new D(1).minus(request.slippage)).toString(),
      request.to,
    ),
    priceImpact: model.impact,
    liquid:
      Number.isFinite(previousVolume) &&
      previousVolume > 0 &&
      notional.lte(new D(previousVolume).mul(model.participation)),
    createdAt: now,
    expiresAt: now + 15000,
    route: ["OHLCV_COST_MODEL"],
    source: "MODEL:OHLCV_NEXT_OPEN_V2",
    dexFeeUsdc: expense(
      beforeFee
        .mul(model.dexFeeRate)
        .mul(buy ? request.referencePrice : 1)
        .toString(),
    ),
  };
}
export function modelCosts(q: QuoteResult, o: ComparisonOptions): Costs {
  return {
    additionalFeeUsdc: expense(
      new D(q.from === USDC ? q.amountIn : q.minAmountOut)
        .div(1e6)
        .mul(o.additionalFeeRate)
        .toString(),
    ),
    gasUsdc: o.gasUsdc === null ? null : expense(String(o.gasUsdc)),
    dexFeeUsdc: q.dexFeeUsdc ?? null,
    source: "PAPER_MODEL",
  };
}
export interface CurvePoint {
  timestamp: number;
  price: number;
  equity: number;
  drawdown: number;
}
export interface BacktestEvent {
  timestamp: number;
  signalTimestamp: number;
  decision: TradingDecision;
  status: "FILLED" | "WAIT" | "REJECTED";
  reasons: string[];
  profit: ProfitReport | null;
  quote: QuoteResult | null;
  trade: Fill | null;
}
export function summarize(
  initial: number,
  portfolio: Portfolio,
  price: number,
  curve: CurvePoint[],
  events: BacktestEvent[],
) {
  const trades = events.flatMap((e) => (e.trade ? [e.trade] : [])),
    sells = trades.filter((t) => t.side === "SELL");
  const profits = sells.map((t) => Number(t.realizedProfitUsdc ?? t.pnl ?? 0)),
    wins = profits.filter((v) => v > 0),
    losses = profits.filter((v) => v < 0);
  let streak = 0,
    maxLosingStreak = 0;
  for (const profit of profits) {
    streak = profit < 0 ? streak + 1 : 0;
    maxLosingStreak = Math.max(streak, maxLosingStreak);
  }
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const sumDecimal = (values: (string | null | undefined)[]) =>
    values.reduce<Decimal>((a, b) => a.plus(b ?? 0), new D(0)).toNumber();
  const additionalFees = sumDecimal(
    trades.map((t) => t.costs?.additionalFeeUsdc),
  );
  const dexFees = sumDecimal(trades.map((t) => t.costs?.dexFeeUsdc));
  const totalGas = sumDecimal(trades.map((t) => t.costs?.gasUsdc));
  const finalEquity = equity(portfolio, price);
  return {
    initialEquity: initial,
    finalEquity,
    netProfitUsdc: new D(finalEquity).minus(initial).toNumber(),
    totalReturnPct: (finalEquity / initial - 1) * 100,
    ...metrics([initial, ...curve.map((c) => c.equity)], profits),
    tradeCount: trades.length,
    buyCount: trades.length - sells.length,
    sellCount: sells.length,
    averageProfit: wins.length ? sum(wins) / wins.length : null,
    averageLoss: losses.length ? sum(losses) / losses.length : null,
    totalFees: new D(additionalFees).plus(dexFees).toNumber(),
    additionalFees,
    dexFees,
    totalGas,
    profitWaitCount: events.filter(
      (e) =>
        e.profit &&
        ["MINIMUM_NET_PROFIT_NOT_MET", "PROJECTED_NET_INSUFFICIENT"].includes(
          e.profit.reason,
        ),
    ).length,
    safetyRejectCount: events.filter((e) => e.status === "REJECTED").length,
    maxLosingStreak,
    unrealizedPnl: portfolio.sui * price - portfolio.costBasis,
    realizedPnl: portfolio.realized,
    winRateDefinition:
      "Each partial SELL is one cost-allocated outcome; zero PnL counts in denominator, resets losing streak. Profit factor=null when losses=0.",
  };
}
export type RunResult = {
  enabled: boolean;
  portfolio: Portfolio;
  curve: CurvePoint[];
  events: BacktestEvent[];
  summary: ReturnType<typeof summarize>;
};
export interface Dependencies {
  // Test-only seams; production callers never supply alternative strategies or quote factories.
  strategyFactory?: (settings: Settings) => TradingStrategy;
  quoteFactory?: typeof modelQuote;
}
async function run(
  c: Candle[],
  o: ComparisonOptions,
  settings: Settings,
  enabled: boolean,
  deps: Dependencies,
): Promise<RunResult> {
  const s = { ...settings, profitGuardEnabled: enabled },
    strategy = deps.strategyFactory?.(s) ?? new RuleBasedStrategy(s);
  const first = c.findIndex((x) => x.timestamp >= o.start),
    paper = new PaperTrading(),
    events: BacktestEvent[] = [],
    curve: CurvePoint[] = [];
  let p = initialPortfolio(c[first].timestamp * 1000, o.initialUsdc),
    peak = o.initialUsdc;
  const filled = new Set<string>(),
    factory = deps.quoteFactory ?? modelQuote;
  for (let i = first; i < c.length && c[i].timestamp <= o.end; i++) {
    // Let authenticated control/stop requests run during long offline comparisons.
    if ((i - first) % 32 === 31)
      await new Promise((resolve) => setTimeout(resolve, 0));
    const bar = c[i],
      history = c.slice(0, i).map((x) => ({ ...x })),
      previous = history.at(-1)!,
      now = bar.timestamp * 1000,
      price = bar.open;
    if (p.day !== dayKey(now))
      p = {
        ...p,
        day: dayKey(now),
        dailyBought: 0,
        dayStartEquity: equity(p, price),
      };
    // Analyze only completed candles. The current bar's open is used only AFTER the decision.
    const decision = await strategy.analyze({
      candles: history,
      current: calculate(history),
      previous: calculate(history.slice(0, -1)),
      entryPrice: p.sui ? p.costBasis / p.sui : null,
      now: (previous.timestamp + previous.timeframe) * 1000,
    });
    const event: BacktestEvent = {
      timestamp: now,
      signalTimestamp: previous.timestamp * 1000,
      decision,
      status: "WAIT",
      reasons: [decision.reason],
      profit: null,
      quote: null,
      trade: null,
    };
    if (decision.action !== "WAIT") {
      const side = decision.action,
        id = `backtest:${bar.timestamp}:${side}`;
      const amount =
        side === "BUY" ? s.maxOrder : Math.min(p.sui, s.maxOrder / price);
      try {
        if (amount <= 0) throw new Error("NO_POSITION");
        const q = factory(
          {
            from: side === "BUY" ? USDC : SUI,
            to: side === "BUY" ? SUI : USDC,
            amountIn: atomic(amount, side === "BUY" ? USDC : SUI),
            slippage: o.slippage,
            referencePrice: price,
          },
          now,
          previous.volume,
          o,
        );
        event.quote = q;
        const costs = modelCosts(q, o),
          config = profitConfigOf(s);
        if (side === "SELL")
          event.profit = evaluateSell({
            position: positionOf(p),
            quote: q,
            costs,
            purpose: decision.sellPurpose ?? "TAKE_PROFIT",
            config,
            now,
          });
        else {
          const reverse = factory(
            {
              from: SUI,
              to: USDC,
              amountIn: q.minAmountOut,
              slippage: o.slippage,
              referencePrice: price,
            },
            now,
            previous.volume,
            o,
          );
          event.profit = evaluateBuy({
            buyQuote: q,
            sellQuote: reverse,
            buyCosts: costs,
            sellCosts: modelCosts(reverse, o),
            config,
            now,
            maxExitUsdc: String(s.maxOrder),
            strategyTargetPrice:
              o.gasUsdc === null
                ? undefined
                : strategyExitPrice(positionOf(p), q, costs, s.takeProfitPct),
          });
        }
        if (!event.profit.allowed) {
          event.reasons = [event.profit.reason];
          event.status = [
            "MINIMUM_NET_PROFIT_NOT_MET",
            "PROJECTED_NET_INSUFFICIENT",
          ].includes(event.profit.reason)
            ? "WAIT"
            : "REJECTED";
        } else {
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
            marketClosedAt: (previous.timestamp + previous.timeframe) * 1000,
            now,
            duplicate: filled.has(id),
            pending: 0,
          });
          if (reasons.length) {
            event.status = "REJECTED";
            event.reasons = reasons;
          } else {
            const fill = paper.fill(id, side, q, p, s, now);
            p = fill.portfolio;
            filled.add(id);
            event.trade = fill.trade;
            event.status = "FILLED";
            event.reasons = [event.profit.reason];
          }
        }
      } catch (error) {
        event.status = "REJECTED";
        event.reasons = [
          error instanceof Error && error.message === "NO_POSITION"
            ? "NO_POSITION"
            : "MODEL_OR_COST_INVALID",
        ];
      }
    }
    events.push(event);
    const value = equity(p, bar.close);
    peak = Math.max(peak, value);
    curve.push({
      timestamp: (bar.timestamp + bar.timeframe) * 1000,
      price: bar.close,
      equity: value,
      drawdown: peak > 0 ? (peak - value) / peak : 0,
    });
  }
  return {
    enabled,
    portfolio: p,
    curve,
    events,
    summary: summarize(o.initialUsdc, p, curve.at(-1)!.price, curve, events),
  };
}
export async function compareBacktests(
  input: Candle[],
  options: ComparisonInput,
  base: Settings = defaults,
  deps: Dependencies = {},
) {
  const o = comparisonOptionsSchema.parse(options);
  if (input.length > 5000) throw new Error("HISTORY_LIMIT_5000");
  // Snapshot inputs and outputs: caller mutation cannot couple the two portfolios.
  const c = structuredClone(input),
    timeframe = c[0]?.timeframe;
  if (!timeframe || c.length < 63)
    throw new Error("INSUFFICIENT_HISTORY_63_CANDLES");
  if (![300,900,3600].includes(timeframe)) throw new Error("INVALID_CANDLE");
  validateCandles(c, timeframe, (c.at(-1)!.timestamp + timeframe) * 1000, 63);
  if (c.some((x) => x.source !== c[0].source))
    throw new Error("MIXED_DATA_SOURCES");
  const first = c.findIndex((x) => x.timestamp >= o.start),
    test = c.filter((x) => x.timestamp >= o.start && x.timestamp <= o.end);
  if (first < 61) throw new Error("INSUFFICIENT_WARMUP_61_CANDLES");
  if (
    test.length < 2 ||
    o.start < c[0].timestamp ||
    o.end > c.at(-1)!.timestamp ||
    o.trainEnd < c[0].timestamp
  )
    throw new Error("PERIOD_OUTSIDE_SAVED_HISTORY");
  const s = settingsSchema.parse({
    ...structuredClone(base),
    maxOrder: o.maxOrder,
    feeRate: o.additionalFeeRate,
    gasUsdc: o.gasUsdc ?? base.gasUsdc,
    // Risk schema keeps its positive safety limit; zero modeled slippage remains a valid quote.
    maxSlippage: o.slippage || base.maxSlippage,
    minNetProfitUsdc: o.minNetProfitUsdc,
    minNetProfitPct: o.minNetProfitPct,
  });
  const off = await run(c, o, s, false, deps),
    on = await run(c, o, s, true, deps);
  return {
    version: 2,
    mode: "PAPER" as const,
    model:
      "OHLCV_NEXT_OPEN_V2: synthetic quotes, NOT historical executable Cetus/DeepBook prices",
    options: o,
    settings: s,
    dataset: {
      source: c[0].source,
      timeframe,
      count: c.length,
      first: c[0].timestamp,
      last: c.at(-1)!.timestamp,
    },
    split: {
      training: { start: c[0].timestamp, end: o.trainEnd },
      validation: { start: o.start, end: o.end },
      optimized: false,
    },
    history: c,
    candles: c.filter((x) => x.timestamp >= o.start && x.timestamp <= o.end),
    off,
    on,
  };
}
export type ComparisonResult = Awaited<ReturnType<typeof compareBacktests>>;
