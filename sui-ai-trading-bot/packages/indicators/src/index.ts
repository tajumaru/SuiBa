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
