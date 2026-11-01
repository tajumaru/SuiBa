import type { Candle } from "../../../packages/shared/src/index.ts";
import { ema, rsi } from "../../../packages/indicators/src/index.ts";

/**
 * A model outlook for the next candles, drawn on the price chart.
 *
 * This is NOT a price prediction and never feeds the bot: it is a
 * transparent statistical sketch — a blended trend extended with
 * damping, widened by a cone whose shape was measured from real
 * forecast errors (in ATR units, per step) — labelled as a model
 * （模式） wherever it is shown. It fails closed (null) unless the
 * trailing candles are contiguous and long enough to carry a
 * trend and a volatility estimate.
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

/** Drift calibrated by walk-forward evaluation on real SUI/USDC
 * 5-minute candles: horizon-end MAE 0.91% (3.5-day window). The
 * same evaluation found the 2-hour direction is a coin flip
 * (about 50%) except when the drift is strong — see
 * DIRECTION_MIN_DRIFT. bandFactor now scales the empirical cone
 * shape below (1 = as measured). */
export const FORECAST_PARAMS: ForecastParams = {
  slopeLookback: 6,
  damping: 0.85,
  bandFactor: 1,
  driftMode: "blend",
};

/** Empirical cone shape: per-step 10%/90% quantiles of actual
 * forecast errors in ATR units, measured walk-forward on 9,991
 * SUI/USDC 5-minute candles (2026-09-27..11-01, 2,297 calibration
 * origins, target coverage 80%). Held-out coverage was 0.846 vs
 * 0.781 for the previous ATR×√t cone. Downside excursions run
 * wider than upside ones in the sample, hence the asymmetry.
 * Re-measure periodically; the shape ages with the market. */
export const CONE_UPPER_SHAPE = [
  1.171, 1.28, 1.54, 1.78, 1.988, 2.174, 2.363, 2.553, 2.721, 2.856,
  2.966, 3.082, 3.16, 3.268, 3.357, 3.494, 3.59, 3.692, 3.794, 3.884,
  3.946, 3.946, 4.018, 4.036,
];
export const CONE_LOWER_SHAPE = [
  1.057, 1.177, 1.443, 1.688, 1.928, 2.118, 2.263, 2.398, 2.551,
  2.752, 2.936, 3.102, 3.234, 3.347, 3.479, 3.598, 3.741, 3.841,
  3.935, 4.027, 4.171, 4.259, 4.375, 4.38,
];

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
      // Beyond the measured horizon, keep widening like the
      // shape's own tail (square-root on the last measured step).
      stretch =
        i < CONE_UPPER_SHAPE.length
          ? 1
          : Math.sqrt((i + 1) / CONE_UPPER_SHAPE.length),
      up =
        atr *
        params.bandFactor *
        CONE_UPPER_SHAPE[Math.min(i, CONE_UPPER_SHAPE.length - 1)] *
        stretch,
      low =
        atr *
        params.bandFactor *
        CONE_LOWER_SHAPE[Math.min(i, CONE_LOWER_SHAPE.length - 1)] *
        stretch;
    points.push({
      timestamp: last.timestamp + (i + 1) * last.timeframe,
      mid,
      upper: mid + up,
      lower: mid - low,
    });
  }
  const driftPct = drift / lastClose,
    bandPct =
      (points.at(-1)!.upper - points.at(-1)!.lower) / 2 / lastClose,
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
