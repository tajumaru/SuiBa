import type { Candle } from "../../../packages/shared/src/index.ts";
import { ema } from "../../../packages/indicators/src/index.ts";
export const chartPeriods = [1, 6, 24, 168] as const;
export function chartData(input: Candle[]) {
  const candles = [...input].sort((a, b) => a.timestamp - b.timestamp);
  const valid = candles.every(
    (b, i) =>
      Number.isFinite(b.timestamp) &&
      b.timestamp > 0 &&
      [b.open, b.high, b.low, b.close].every(Number.isFinite) &&
      b.high >= Math.max(b.open, b.close, b.low) &&
      b.low <= Math.min(b.open, b.close) &&
      [300, 900, 3600].includes(b.timeframe) &&
      b.timeframe === candles[0].timeframe &&
      (!i || b.timestamp > candles[i - 1].timestamp),
  );
  if (!valid)
    return {
      candles: [] as Candle[],
      ema20: [] as (number | null)[],
      ema50: [] as (number | null)[],
    };
  const values = candles.map((b) => b.close);
  return { candles, ema20: ema(values, 20), ema50: ema(values, 50) };
}
export function chartWindow(
  data: ReturnType<typeof chartData>,
  span: number,
  requestedEnd?: number,
) {
  const all = data.candles;
  if (!all.length)
    return {
      candles: all,
      ema20: [],
      ema50: [],
      start: null,
      end: null,
      available: 0,
    };
  const first = all[0].timestamp,
    last = all.at(-1)!,
    latest = last.timestamp + last.timeframe;
  const actualSpan = Math.min(Math.max(last.timeframe, span), latest - first);
  const end = Math.max(
    first + actualSpan,
    Math.min(latest, requestedEnd ?? latest),
  );
  const indices = all.flatMap((b, i) =>
    b.timestamp >= end - actualSpan && b.timestamp < end ? [i] : [],
  );
  return {
    candles: indices.map((i) => all[i]),
    ema20: indices.map((i) => data.ema20[i]),
    ema50: indices.map((i) => data.ema50[i]),
    start: indices.length ? all[indices[0]].timestamp : null,
    end: indices.length
      ? all[indices.at(-1)!].timestamp + last.timeframe
      : null,
    available: latest - first,
  };
}
export function chartTime(seconds: number, includeDate = true) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    ...(includeDate
      ? { year: "numeric", month: "2-digit", day: "2-digit" }
      : {}),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(seconds * 1000));
}
export function chartTicks(candles: Candle[], width: number) {
  const count = Math.min(candles.length, Math.max(2, Math.floor(width / 135)));
  const sameDay =
    candles.length > 0 &&
    chartTime(candles[0].timestamp).slice(0, 10) ===
      chartTime(candles.at(-1)!.timestamp).slice(0, 10);
  return Array.from(
    { length: count },
    (_, i) =>
      candles[Math.round((i * (candles.length - 1)) / Math.max(1, count - 1))],
  ).map((b) => ({
    timestamp: b.timestamp,
    label: sameDay
      ? chartTime(b.timestamp, false)
      : chartTime(b.timestamp).slice(5),
  }));
}
