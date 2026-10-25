import type {
  TradingStrategy,
  TradingDecision,
  MarketContext,
  Settings,
} from "../../shared/src/index.ts";
export class RuleBasedStrategy implements TradingStrategy {
  constructor(private settings: Settings) {}
  async analyze(c: MarketContext): Promise<TradingDecision> {
    const s = this.settings,
      i = c.current,
      p = c.previous,
      price = c.candles.at(-1)!.close;
    const conditions = {
      hasPosition: c.entryPrice !== null,
      stopLoss:
        c.entryPrice !== null && price <= c.entryPrice * (1 - s.stopLossPct),
      takeProfit:
        c.entryPrice !== null && price >= c.entryPrice * (1 + s.takeProfitPct),
      latestVolumePositive: c.candles.at(-1)!.volume > 0,
      previousVolumePositive: c.candles.at(-2)!.volume > 0,
      volumeChangeExceeded: Math.abs(i.volumeChange) > s.maxVolumeChange,
      emaUp: i.ema20 > i.ema50,
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
      i.ema20 > i.ema50 &&
      p.rsi <= s.oversold &&
      i.rsi > s.oversold &&
      i.histogram > p.histogram
    ) {
      action = "BUY";
      selectedRule = "BUY_SIGNAL";
      reason = "EMA上昇・RSI回復・MACD改善";
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
    const direction = action === "SELL" ? -1 : 1;
    const agreement =
      action === "SELL"
        ? [
            conditions.emaDown,
            conditions.rsiReversal,
            conditions.histogramDeclining,
          ]
        : [
            conditions.emaUp,
            conditions.rsiRecovery,
            conditions.histogramImproving,
          ];
    const indicatorAgreement = agreement.filter(Boolean).length / 3;
    const volumeQuality =
      conditions.latestVolumePositive && conditions.previousVolumePositive
        ? Math.max(0, 1 - Math.abs(i.volumeChange) / s.maxVolumeChange)
        : 0;
    const book = usableBook(c) ? c.book! : null;
    const bookSupport = book ? (1 + direction * book.imbalance) / 2 : null;
    const spreadQuality = book
      ? Math.max(0, 1 - book.spreadBps / (s.maxSlippage * 10000))
      : null;
    // Descriptive weighted agreement only; no empirical win probability is claimed.
    const score =
      action === "WAIT"
        ? 0
        : (0.5 * indicatorAgreement +
            0.2 * volumeQuality +
            (bookSupport === null ? 0 : 0.2 * bookSupport) +
            (spreadQuality === null ? 0 : 0.1 * spreadQuality)) /
          (book ? 1 : 0.7);
    return {
      scoreEvidence: {
        version: 1,
        kind: "UNCALIBRATED_SCORE",
        indicatorAgreement,
        volumeQuality,
        bookSupport,
        spreadQuality,
        score,
        book,
      },
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
        },
        conditions,
        selectedRule,
      },
      action,
      confidence: score,
      reason,
      stopLossPct: s.stopLossPct,
      takeProfitPct: s.takeProfitPct,
      timestamp: new Date(c.now).toISOString(),
      sellPurpose,
    };
  }
}
function usableBook(c: MarketContext) {
  const b = c.book;
  return (
    !!b &&
    b.version === 1 &&
    Number.isFinite(b.timestamp) &&
    b.timestamp <= b.evaluatedAt &&
    b.evaluatedAt <= c.now &&
    c.now - b.timestamp <= 10000 &&
    [b.bidDepthUsdc, b.askDepthUsdc, b.imbalance, b.spreadBps].every(
      Number.isFinite,
    ) &&
    b.bidDepthUsdc > 0 &&
    b.askDepthUsdc > 0 &&
    Math.abs(b.imbalance) <= 1 &&
    b.spreadBps > 0 &&
    Array.isArray(b.estimates) &&
    b.estimates.every(
      (e) => Number.isFinite(e.quantitySui) && e.quantitySui > 0,
    )
  );
}

/** Opt-in offline/shadow strategy. Existing live worker registration remains rule-based. */
export class BookAwareStrategy implements TradingStrategy {
  constructor(private settings: Settings) {}
  async analyze(c: MarketContext): Promise<TradingDecision> {
    const d = await new RuleBasedStrategy(this.settings).analyze(c);
    if (
      d.action === "WAIT" ||
      d.sellPurpose === "STOP_LOSS" ||
      d.sellPurpose === "TAKE_PROFIT"
    )
      return d;
    let reason: string | null = null;
    if (!usableBook(c)) reason = "BOOK_MISSING_STALE_OR_INVALID";
    else {
      const b = c.book!,
        direction = d.action === "BUY" ? 1 : -1;
      const quantity = this.settings.maxOrder / c.candles.at(-1)!.close;
      const estimate = b.estimates.find((e) => e.quantitySui >= quantity);
      const impact = d.action === "BUY" ? estimate?.buyBps : estimate?.sellBps;
      if (
        impact == null ||
        !Number.isFinite(impact) ||
        impact < 0 ||
        impact > this.settings.maxSlippage * 10000
      )
        reason = "BOOK_SLIPPAGE_OR_DEPTH";
      else if (b.spreadBps > this.settings.maxSlippage * 10000)
        reason = "BOOK_SPREAD";
      else if (direction * b.imbalance < 0.1) reason = "BOOK_IMBALANCE";
    }
    return reason
      ? {
          ...d,
          action: "WAIT",
          confidence: 0,
          reason,
          scoreEvidence: d.scoreEvidence
            ? { ...d.scoreEvidence, score: 0 }
            : undefined,
        }
      : d;
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
