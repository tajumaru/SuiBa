import type { Candle, Timeframe } from "../../shared/src/index.ts";
export function validateCandles(
  c: Candle[],
  timeframe: Timeframe,
  now: number,
  min = 61,
) {
  if (c.length < min) throw new Error("INSUFFICIENT_CANDLES");
  for (let i = 0; i < c.length; i++) {
    const x = c[i];
    if (
      x.timeframe !== timeframe ||
      !x.source ||
      ![x.timestamp, x.open, x.high, x.low, x.close, x.volume].every(
        Number.isFinite,
      ) ||
      x.timestamp % timeframe !== 0 ||
      x.timestamp + timeframe > now / 1000 ||
      Math.min(x.open, x.high, x.low, x.close) <= 0 ||
      x.volume < 0 ||
      x.low > Math.min(x.open, x.close) ||
      x.high < Math.max(x.open, x.close) ||
      x.low > x.high
    )
      throw new Error("INVALID_CANDLE");
    if (i && x.timestamp - c[i - 1].timestamp !== timeframe)
      throw new Error("CANDLE_GAP");
    if (i && Math.abs(x.close / c[i - 1].close - 1) > 0.3)
      throw new Error("PRICE_OUTLIER");
  }
  if (now / 1000 - (c.at(-1)!.timestamp + timeframe) > timeframe + 60)
    throw new Error("STALE_CANDLES");
  return c;
}
