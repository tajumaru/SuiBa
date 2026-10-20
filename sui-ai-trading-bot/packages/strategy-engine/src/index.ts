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
    let action: TradingDecision["action"] = "WAIT",
      reason = "条件未成立";
    if (
      c.entryPrice !== null &&
      (price <= c.entryPrice * (1 - s.stopLossPct) ||
        price >= c.entryPrice * (1 + s.takeProfitPct))
    ) {
      action = "SELL";
      reason = "損切り / 利確条件";
    } else if (
      c.candles.at(-1)!.volume <= 0 ||
      c.candles.at(-2)!.volume <= 0 ||
      Math.abs(i.volumeChange) > s.maxVolumeChange
    ) {
      reason = "出来高異常";
    } else if (
      i.ema20 > i.ema50 &&
      p.rsi <= s.oversold &&
      i.rsi > s.oversold &&
      i.histogram > p.histogram
    ) {
      action = "BUY";
      reason = "EMA上昇・RSI回復・MACD改善";
    } else if (
      i.ema20 < i.ema50 &&
      p.rsi >= s.overbought &&
      i.rsi < s.overbought &&
      i.histogram < p.histogram
    ) {
      action = "SELL";
      reason = "EMA下降・RSI反落・MACD悪化";
    }
    return {
      action,
      confidence: action === "WAIT" ? 0 : 0.7,
      reason,
      stopLossPct: s.stopLossPct,
      takeProfitPct: s.takeProfitPct,
      timestamp: new Date(c.now).toISOString(),
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
