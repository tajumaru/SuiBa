import type {
  TradingStrategy,
  TradingDecision,
  MarketContext,
  Settings,
  Candle,
} from "../../shared/src/index.ts";
import { ema, rsiTargetPrice } from "../../indicators/src/index.ts";
/**
 * Whether the EMA gap — (ema50 − ema20) as a share of the close —
 * shrank monotonically across the most recent `count` candles,
 * latest included: every consecutive pair in that window must be
 * strictly smaller than the pair before it. The series is recomputed
 * from the context candles with the shared EMA implementation, the
 * same inputs the caller's `calculate` used for the current and
 * previous snapshots, so the live engine and both backtest paths see
 * identical values with no second EMA implementation to drift.
 * Fails closed (false) when any candle in the window lacks a full
 * EMA50, a positive close, or a still-open gap at the latest candle.
 */
export function emaGapShrinking(candles: Candle[], count: number): boolean {
  if (candles.length < count) return false;
  const closes = candles.map((x) => x.close),
    e20 = ema(closes, 20),
    e50 = ema(closes, 50);
  let previous = Infinity;
  for (let k = candles.length - count; k < candles.length; k++) {
    const a = e20[k],
      b = e50[k],
      close = closes[k];
    if (a == null || b == null || !(close > 0)) return false;
    const gap = (b - a) / close;
    if (!(gap < previous)) return false;
    previous = gap;
  }
  // The latest gap must still be open (ema20 below ema50): a closed
  // or crossed gap belongs to the ordinary route, not to a shrink.
  return previous > 0;
}
export class RuleBasedStrategy implements TradingStrategy {
  constructor(private settings: Settings) {}
  async analyze(c: MarketContext): Promise<TradingDecision> {
    const s = this.settings,
      i = c.current,
      p = c.previous,
      price = c.candles.at(-1)!.close;
    // Buy-side EMA route: ordinarily EMA20 must sit above EMA50.
    // With the gap-shrink option on, a still-open gap that has been
    // shrinking for the configured run of candles also counts as
    // met, so a flattening decline can qualify before the cross.
    const emaAbove = i.ema20 > i.ema50,
      emaShrink =
        s.emaGapShrinkEnabled && !emaAbove
          ? emaGapShrinking(c.candles, s.emaGapShrinkCandles)
          : false,
      emaUp = emaAbove || emaShrink;
    const conditions = {
      hasPosition: c.entryPrice !== null,
      stopLoss:
        c.entryPrice !== null && price <= c.entryPrice * (1 - s.stopLossPct),
      takeProfit:
        c.entryPrice !== null && price >= c.entryPrice * (1 + s.takeProfitPct),
      latestVolumePositive: c.candles.at(-1)!.volume > 0,
      previousVolumePositive: c.candles.at(-2)!.volume > 0,
      volumeChangeExceeded: Math.abs(i.volumeChange) > s.maxVolumeChange,
      emaUp,
      emaGapShrinking: emaShrink,
      rsiRecovery: p.rsi <= s.oversold && i.rsi > s.oversold,
      histogramImproving: i.histogram > p.histogram,
      emaDown: i.ema20 < i.ema50,
      rsiReversal: p.rsi >= s.overbought && i.rsi < s.overbought,
      histogramDeclining: i.histogram < p.histogram,
    };
    let selectedRule = "NO_SIGNAL";
    let action: TradingDecision["action"] = "WAIT",
      reason = "条件未成立";
    let sellPurpose: TradingDecision["sellPurpose"];
    if (
      c.entryPrice !== null &&
      (price <= c.entryPrice * (1 - s.stopLossPct) ||
        price >= c.entryPrice * (1 + s.takeProfitPct))
    ) {
      action = "SELL";
      selectedRule = conditions.stopLoss ? "STOP_LOSS" : "TAKE_PROFIT";
      reason = "損切り / 利確条件";
      sellPurpose =
        price <= c.entryPrice! * (1 - s.stopLossPct)
          ? "STOP_LOSS"
          : "TAKE_PROFIT";
    } else if (
      c.candles.at(-1)!.volume <= 0 ||
      c.candles.at(-2)!.volume <= 0 ||
      Math.abs(i.volumeChange) > s.maxVolumeChange
    ) {
      reason = "出来高異常";
      selectedRule = "VOLUME_REJECT";
    } else if (
      emaUp &&
      p.rsi <= s.oversold &&
      i.rsi > s.oversold &&
      i.histogram > p.histogram
    ) {
      action = "BUY";
      selectedRule = "BUY_SIGNAL";
      reason = emaShrink
        ? "EMA差縮小・RSI回復・MACD改善"
        : "EMA上昇・RSI回復・MACD改善";
    } else if (
      i.ema20 < i.ema50 &&
      p.rsi >= s.overbought &&
      i.rsi < s.overbought &&
      i.histogram < p.histogram
    ) {
      action = "SELL";
      reason = "EMA下降・RSI反落・MACD悪化";
      selectedRule = "SELL_SIGNAL";
      sellPurpose = "STRATEGY_EXIT";
    }
    // The buy-run line for the dashboard: only when RSI is the one
    // missing piece — EMA route met, histogram improving, volumes
    // usable, no position open, RSI still above the oversold line.
    // Pure display derivation from the same closes the decision
    // used; it never feeds back into action, reason or gating.
    const rsiLinePrice =
      emaUp &&
      conditions.histogramImproving &&
      conditions.latestVolumePositive &&
      conditions.previousVolumePositive &&
      !conditions.volumeChangeExceeded &&
      c.entryPrice === null &&
      i.rsi > s.oversold
        ? rsiTargetPrice(
            c.candles.map((x) => x.close),
            s.oversold,
          )
        : null;
    return {
      evidence: {
        version: 1,
        evaluatedAt: c.now,
        candleTimestamp: c.candles.at(-1)!.timestamp,
        previousCandleTimestamp: c.candles.at(-2)!.timestamp,
        inputs: {
          price,
          latestVolume: c.candles.at(-1)!.volume,
          previousVolume: c.candles.at(-2)!.volume,
          entryPrice: c.entryPrice,
          current: { ...i },
          previous: { ...p },
        },
        thresholds: {
          oversold: s.oversold,
          overbought: s.overbought,
          maxVolumeChange: s.maxVolumeChange,
          stopLossPct: s.stopLossPct,
          takeProfitPct: s.takeProfitPct,
          emaGapShrinkEnabled: s.emaGapShrinkEnabled,
          emaGapShrinkCandles: s.emaGapShrinkCandles,
        },
        conditions,
        selectedRule,
        rsiLinePrice,
      },
      action,
      confidence: action === "WAIT" ? 0 : 0.7,
      reason,
      stopLossPct: s.stopLossPct,
      takeProfitPct: s.takeProfitPct,
      timestamp: new Date(c.now).toISOString(),
      sellPurpose,
    };
  }
}
export class StrategyRegistry {
  private strategies = new Map<string, TradingStrategy>();
  register(name: string, strategy: TradingStrategy) {
    if (this.strategies.has(name)) throw new Error("DUPLICATE_STRATEGY");
    this.strategies.set(name, strategy);
  }
  get(name: string) {
    const s = this.strategies.get(name);
    if (!s) throw new Error("STRATEGY_UNAVAILABLE");
    return s;
  }
}
