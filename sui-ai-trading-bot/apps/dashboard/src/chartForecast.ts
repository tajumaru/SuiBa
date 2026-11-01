import type { Candle } from "../../../packages/shared/src/index.ts";
import { ema, rsi } from "../../../packages/indicators/src/index.ts";

/**
 * A model outlook for the next candles, drawn on the price chart.
 *
 * This is NOT a price prediction and never feeds the bot: it is a
 * transparent statistical sketch — the recent EMA20 trend extended
 * with damping, widened by the recent average true range — labelled
 * as a model （模式） wherever it is shown. It fails closed (null)
 * unless the trailing candles are contiguous and long enough to
 * carry a trend and a volatility estimate.
 */
export const FORECAST_BARS = 24;

export interface ForecastPoint {
  /** Start time (seconds) of the projected candle. */
  timestamp: number;
  mid: number;
  upper: number;
  lower: number;
}

export interface ChartForecast {
  points: ForecastPoint[];
  /** Total mid drift over the horizon, as a fraction of last close. */
  driftPct: number;
  /** Final half-band width, as a fraction of last close. */
  bandPct: number;
  direction: "up" | "down" | "flat";
  directionWord: string;
}

const MIN_RUN = 26;

export interface ForecastParams {
  slopeLookback: number;
  damping: number;
  bandFactor: number;
  /** "ema": EMA20 slope only. "blend": EMA slope averaged with a
   * least-squares slope, damped when RSI is at an extreme. */
  driftMode: "ema" | "blend";
}

/** Calibrated by walk-forward evaluation on real SUI/USDC
 * 5-minute candles (1,000 candles, 2026-10-29..11-01, 299
 * origins): cone coverage 0.81, horizon-end MAE 0.91%. The same
 * evaluation found the 2-hour direction is a coin flip (about
 * 50%) except when the drift is strong — see DIRECTION_MIN_DRIFT. */
export const FORECAST_PARAMS: ForecastParams = {
  slopeLookback: 6,
  damping: 0.85,
  bandFactor: 0.75,
  driftMode: "blend",
};

/** A direction word is only claimed when the projected drift is
 * at least this large: at |drift| >= 0.5% the walk-forward hit
 * rate was 67% (n=33); below it, direction carried no signal. */
export const DIRECTION_MIN_DRIFT = 0.005;

export function chartForecast(
  candles: Candle[],
  bars: number = FORECAST_BARS,
): ChartForecast | null {
  return forecastWith(candles, bars, FORECAST_PARAMS);
}

export function forecastWith(
  candles: Candle[],
  bars: number,
  params: ForecastParams,
): ChartForecast | null {
  if (!candles.length || bars < 1) return null;
  // Only the trailing contiguous run can carry a trend; a gap
  // restarts the run (same rule as the chart's own series).
  let runStart = candles.length - 1;
  while (
    runStart > 0 &&
    candles[runStart].timestamp ===
      candles[runStart - 1].timestamp + candles[runStart - 1].timeframe
  )
    runStart--;
  const run = candles.slice(runStart).slice(-80);
  if (run.length < MIN_RUN) return null;
  const closes = run.map((c) => c.close);
  const e20 = ema(closes, 20);
  const lastEma = e20.at(-1),
    pastEma = e20.at(-1 - params.slopeLookback);
  if (lastEma == null || pastEma == null) return null;
  let slope = (lastEma - pastEma) / params.slopeLookback;
  if (params.driftMode === "blend") {
    // Least-squares slope of the last 20 closes, averaged with
    // the EMA slope so one noisy print cannot swing the outlook.
    const w = closes.slice(-20),
      n = w.length,
      meanX = (n - 1) / 2,
      meanY = w.reduce((a, b) => a + b, 0) / n;
    let num = 0,
      den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - meanX) * (w[i] - meanY);
      den += (i - meanX) ** 2;
    }
    if (den > 0) slope = (slope + num / den) / 2;
    // Mean-reversion brake: pushing further into an RSI extreme
    // is where naive trend extension fails most, so fade it.
    const r = rsi(closes);
    if ((r >= 70 && slope > 0) || (r <= 30 && slope < 0)) slope *= 0.4;
  }
  // Average true range over the last 14 candles of the run.
  const tail = run.slice(-15);
  let atr = 0;
  for (let i = 1; i < tail.length; i++) {
    const c = tail[i],
      prev = tail[i - 1];
    atr += Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
  }
  atr /= Math.max(1, tail.length - 1);
  const last = run.at(-1)!,
    lastClose = last.close;
  if (
    !Number.isFinite(slope) ||
    !Number.isFinite(atr) ||
    atr <= 0 ||
    !(lastClose > 0)
  )
    return null;
  const points: ForecastPoint[] = [];
  let drift = 0;
  for (let i = 0; i < bars; i++) {
    drift += slope * params.damping ** i;
    const mid = lastClose + drift,
      half = atr * Math.sqrt(i + 1) * params.bandFactor;
    points.push({
      timestamp: last.timestamp + (i + 1) * last.timeframe,
      mid,
      upper: mid + half,
      lower: mid - half,
    });
  }
  const driftPct = drift / lastClose,
    bandPct =
      (points.at(-1)!.upper - points.at(-1)!.mid) / lastClose,
    direction =
      Math.abs(driftPct) >= DIRECTION_MIN_DRIFT
        ? driftPct > 0
          ? "up"
          : "down"
        : "flat";
  return {
    points,
    driftPct,
    bandPct,
    direction,
    directionWord:
      direction === "up"
        ? "上向き気味"
        : direction === "down"
          ? "下向き気味"
          : "横ばい気味",
  };
}
