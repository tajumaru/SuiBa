import type {
  Candle,
  Indicators,
  MarketWeather,
} from "../../../packages/shared/src/index.ts";

/**
 * 相場の天気 (market weather): a mechanical five-grade read of
 * the last 24 hours of a pair, from the three numbers the bot
 * already watches — the 24h close-to-close change, the
 * volatility (ATR(14) as % of the latest close) and RSI(14).
 * It is a description of the sky right now, not a forecast,
 * and it feeds no trading decision.
 *
 * Bands, calibrated on the saved SUI 5-minute series
 * (9,991 candles, 2025-09-27 – 11-01, GeckoTerminal; 9,703
 * samples after the 24h warm-up):
 * - ATR% percentiles: p50 0.334 / p90 0.549 / p95 0.652 /
 *   p99 0.908. The storm band is the p95 line, so 嵐 fires
 *   about 5% of the time (measured 5.1%) and outranks any
 *   direction: in a storm the direction is not the story.
 * - 24h change: |change| p50 2.45% / p90 5.86%. The 晴れ/雨
 *   boundary is a symmetric ±1.5% (signed p75 was +1.62%),
 *   and 快晴 additionally needs a strong +4% with momentum
 *   (RSI ≥ 55) behind it — a rise RSI does not follow is
 *   only 晴れ.
 * Grade shares on that (falling-market) sample: 快晴 3.5% /
 * 晴れ 21.8% / 曇り 31.3% / 雨 38.4% / 嵐 5.1% — rain leads
 * because the sample month fell 28%, not because the bands
 * lean that way.
 */
export const WEATHER_STORM_ATR_PCT = 0.65;
export const WEATHER_STRONG_CHANGE_PCT = 4;
export const WEATHER_CHANGE_PCT = 1.5;
export const WEATHER_CLEAR_RSI = 55;

const DAY_SECONDS = 86400;
/** The 24h-ago reference candle may lag the exact mark by at
 * most this much (three 5-minute candles) before the series
 * counts as not covering the window. */
const REFERENCE_TOLERANCE_SECONDS = 900;

export function marketWeather(
  candles: readonly Candle[],
  indicators: Indicators | null,
): MarketWeather | null {
  if (!indicators) return null;
  const { rsi, atr } = indicators;
  if (!Number.isFinite(rsi) || !Number.isFinite(atr) || atr < 0)
    return null;
  const last = candles.at(-1);
  if (!last || !(last.close > 0)) return null;
  const target = last.timestamp - DAY_SECONDS;
  let ref: Candle | null = null;
  for (const candle of candles) {
    if (candle.timestamp > target) break;
    ref = candle;
  }
  if (!ref || !(ref.close > 0)) return null;
  if (target - ref.timestamp > REFERENCE_TOLERANCE_SECONDS) return null;
  const change24hPct = (last.close / ref.close - 1) * 100;
  const atrPct = (atr / last.close) * 100;
  const kind =
    atrPct >= WEATHER_STORM_ATR_PCT
      ? "storm"
      : change24hPct >= WEATHER_STRONG_CHANGE_PCT && rsi >= WEATHER_CLEAR_RSI
        ? "clear"
        : change24hPct >= WEATHER_CHANGE_PCT
          ? "sunny"
          : change24hPct <= -WEATHER_CHANGE_PCT
            ? "rain"
            : "cloudy";
  return { kind, change24hPct, atrPct, rsi };
}
