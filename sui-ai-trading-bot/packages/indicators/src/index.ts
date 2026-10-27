import type { Candle, Indicators } from "../../shared/src/index.ts";
export function ema(values: number[], period: number): (number | null)[] {
  let value = 0;
  return values.map((x, i) => {
    if (i < period) value += x;
    if (i < period - 1) return null;
    if (i === period - 1) value /= period;
    else value += ((x - value) * 2) / (period + 1);
    return value;
  });
}
export function rsi(values: number[], period = 14) {
  if (values.length <= period) throw new Error("INSUFFICIENT_DATA");
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(0, d) / period;
    loss += Math.max(0, -d) / period;
  }
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
}
/**
 * The close price at which one more candle appended to `values`,
 * closing at that price, would bring RSI exactly to `target` —
 * solved by bisection over the shared rsi() above, so the answer
 * always agrees with the indicator the strategy itself uses.
 * Display-only derivation (a "where is the line" gauge); it feeds
 * no decision. Returns null when the question has no answer below
 * the latest close: RSI already at or under the target, too little
 * data, or even a zero close could not pull RSI down to the target.
 */
export function rsiTargetPrice(
  values: number[],
  target: number,
  period = 14,
): number | null {
  if (values.length <= period) return null;
  const last = values.at(-1)!;
  if (!(last > 0) || !(target > 0) || target >= 100) return null;
  if (!(rsi(values, period) > target)) return null;
  if (rsi([...values, 0], period) > target) return null;
  let lo = 0,
    hi = last;
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    if (rsi([...values, mid], period) > target) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
export function calculate(c: Candle[]): Indicators {
  if (c.length < 60) throw new Error("INSUFFICIENT_DATA");
  const p = c.map((x) => x.close),
    e12 = ema(p, 12),
    e26 = ema(p, 26);
  const macds = p.flatMap((_, i) =>
    e26[i] === null ? [] : [e12[i]! - e26[i]!],
  );
  const macd = macds.at(-1)!,
    signal = ema(macds, 9).at(-1)!;
  const tr = c
    .slice(1)
    .map((x, i) =>
      Math.max(
        x.high - x.low,
        Math.abs(x.high - c[i].close),
        Math.abs(x.low - c[i].close),
      ),
    );
  let atr = tr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
  for (const t of tr.slice(14)) atr = (atr * 13 + t) / 14;
  return {
    ema20: ema(p, 20).at(-1)!,
    ema50: ema(p, 50).at(-1)!,
    rsi: rsi(p),
    macd,
    signal,
    histogram: macd - signal,
    atr,
    volumeChange:
      c.at(-2)!.volume === 0 ? 0 : c.at(-1)!.volume / c.at(-2)!.volume - 1,
    priceChange: p.at(-1)! / p.at(-2)! - 1,
  };
}
