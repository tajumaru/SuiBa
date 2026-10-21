import type { Candle } from "../../../packages/shared/src/index.ts";
import { ema, rsi } from "../../../packages/indicators/src/index.ts";
export function chartSeries(candles: Candle[]) {
  const result = {
    ema20: [] as (number | null)[],
    ema50: [] as (number | null)[],
    rsi: [] as (number | null)[],
    macd: [] as (number | null)[],
    signal: [] as (number | null)[],
    histogram: [] as (number | null)[],
  };
  for (let start = 0; start < candles.length;) {
    let end = start + 1;
    while (
      end < candles.length &&
      candles[end].timestamp ===
        candles[end - 1].timestamp + candles[end - 1].timeframe
    )
      end++;
    const p = candles.slice(start, end).map((c) => c.close),
      e20 = ema(p, 20),
      e50 = ema(p, 50),
      e12 = ema(p, 12),
      e26 = ema(p, 26),
      m = e26.flatMap((v, i) => (v == null ? [] : [e12[i]! - v])),
      signals = ema(m, 9);
    for (let i = 0; i < p.length; i++) {
      result.ema20.push(e20[i]);
      result.ema50.push(e50[i]);
      result.rsi.push(i < 59 ? null : rsi(p.slice(0, i + 1)));
      const value = i < 59 ? null : e12[i]! - e26[i]!,
        signal = i < 59 ? null : signals[i - 25];
      result.macd.push(value);
      result.signal.push(signal);
      result.histogram.push(
        value == null || signal == null ? null : value - signal,
      );
    }
    start = end;
  }
  return result;
}
export function lineSegments(
  candles: Candle[],
  values: (number | null)[],
  x: (timestamp: number) => number,
  y: (value: number) => number,
) {
  const paths: string[] = [];
  let points: string[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (
      values[i] == null ||
      (i > 0 &&
        candles[i].timestamp !==
          candles[i - 1].timestamp + candles[i - 1].timeframe)
    ) {
      if (points.length) paths.push(points.join(" "));
      points = [];
    }
    if (values[i] != null)
      points.push(
        `${x(candles[i].timestamp + candles[i].timeframe / 2)},${y(values[i]!)}`,
      );
  }
  if (points.length) paths.push(points.join(" "));
  return paths;
}
