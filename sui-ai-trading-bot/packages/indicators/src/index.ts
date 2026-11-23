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
type RsiState = { gain: number; loss: number };

function seedRsi(values: number[], period: number): RsiState {
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(0, d) / period;
    loss += Math.max(0, -d) / period;
  }
  return { gain, loss };
}

function advanceRsi(state: RsiState, d: number, period: number) {
  state.gain = (state.gain * (period - 1) + Math.max(d, 0)) / period;
  state.loss = (state.loss * (period - 1) + Math.max(-d, 0)) / period;
}

function rsiValue({ gain, loss }: RsiState) {
  return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
}

function rsiState(values: number[], period: number): RsiState {
  const state = seedRsi(values, period);
  for (let i = period + 1; i < values.length; i++)
    advanceRsi(state, values[i] - values[i - 1], period);
  return state;
}

export function rsi(values: number[], period = 14) {
  if (values.length <= period) throw new Error("INSUFFICIENT_DATA");
  return rsiValue(rsiState(values, period));
}
/**
 * The close price at which one more candle appended to `values`,
 * closing at that price, would bring RSI exactly to `target` —
 * solved by bisection using the same RSI update, so the answer
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
  const state = rsiState(values, period);
  if (!(rsiValue(state) > target)) return null;
  const nextRsi = (close: number) => {
    if (!Number.isInteger(period)) return rsi([...values, close], period);
    const next = { ...state };
    advanceRsi(next, close - last, period);
    return rsiValue(next);
  };
  if (nextRsi(0) > target) return null;
  let lo = 0,
    hi = last;
  for (let n = 0; n < 60; n++) {
    const mid = (lo + hi) / 2;
    if (nextRsi(mid) > target) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}
export function calculateSeries(c: Candle[]): (Indicators | null)[] {
  if (c.length < 60) return c.map(() => null);

  const p = c.map((x) => x.close),
    e12 = ema(p, 12),
    e26 = ema(p, 26),
    e20 = ema(p, 20),
    e50 = ema(p, 50);
  const macdStart = 25;
  const macds = e26
      .slice(macdStart)
      .map((value, i) => e12[i + macdStart]! - value!),
    signals = ema(macds, 9);
  const period = 14,
    state = seedRsi(p, period);
  let atr = 0;

  return c.map((bar, i) => {
    if (i === 0) return null;
    const previous = c[i - 1];
    const tr = Math.max(
      bar.high - bar.low,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close),
    );
    // ATR divides the sum once, while the RSI seed divides each contribution.
    if (i <= period) {
      atr += tr;
      if (i === period) atr /= period;
    } else {
      atr = (atr * (period - 1) + tr) / period;
      advanceRsi(state, bar.close - previous.close, period);
    }
    if (i < 59) return null;

    const macd = macds[i - macdStart],
      signal = signals[i - macdStart]!;
    return {
      ema20: e20[i]!,
      ema50: e50[i]!,
      rsi: rsiValue(state),
      macd,
      signal,
      histogram: macd - signal,
      atr,
      volumeChange:
        previous.volume === 0 ? 0 : bar.volume / previous.volume - 1,
      priceChange: bar.close / previous.close - 1,
    };
  });
}

export function calculate(c: Candle[]): Indicators {
  if (c.length < 60) throw new Error("INSUFFICIENT_DATA");
  return calculateSeries(c).at(-1)!;
}
