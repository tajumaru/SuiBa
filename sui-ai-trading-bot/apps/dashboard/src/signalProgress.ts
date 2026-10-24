import type { SignalTelemetry } from "../../worker/src/operations.ts";

/**
 * 「あと一歩ゲージ」: how close the rule-based strategy's BUY entry is.
 *
 * The strategy (packages/strategy-engine) buys only when ALL of these
 * hold on the same candle, and this module measures exactly those
 * three conditions against the evidence the strategy itself recorded
 * (see `signalTelemetry` in apps/worker/src/operations.ts):
 *   1. EMA:  current EMA20 > EMA50
 *   2. RSI:  previous RSI <= oversold threshold AND current RSI > it
 *      (a recovery cross out of the oversold zone — an event, not a
 *      level, so the gauge tracks distance to the threshold from
 *      whichever side the current RSI is on; see `phase` in the code)
 *   3. MACD: current histogram > previous histogram (improving)
 *
 * Whether a condition holds is taken verbatim from the strategy's own
 * recorded `conditions` — this module never re-decides it. Progress
 * (0–100) is a display normalisation of the remaining distance, NOT a
 * probability and NOT a strategy input:
 *   - EMA:  distance = (EMA50 − EMA20) / price, in %. Progress reaches
 *     100 at the crossing; the window is 1% of price (a spread 1% below
 *     the crossing reads 0). 成立時は 100。
 *   - RSI:  distance = |current RSI − oversold|, in RSI points.
 *     Window is 10 points.
 *   - MACD: distance = (previous − current) histogram change,
 *     normalised by ATR (the candle's typical range). Window is
 *     0.25 ATR of histogram improvement per candle.
 * Unmet gauges are capped at 99 so that 100 always means 成立.
 * `overall` is the minimum gauge progress — the bottleneck condition
 * decides how close the BUY entry is, because all three must hold at
 * once. Phases: <55 far, 55–84 approaching, 85–99 almost（あと一歩）,
 * all met = ready.
 */

export type SignalPhase = "far" | "approaching" | "almost" | "ready";

export interface SignalGauge {
  id: "ema" | "rsi" | "macd";
  /** Gauge title, naming the strategy condition. */
  label: string;
  /** 0–100 display progress; 100 only when the condition holds. */
  progress: number;
  /** The strategy's own verdict for this condition. */
  met: boolean;
  /** What remains, in the condition's own units (empty when met). */
  remainingText: string;
  /** Current values behind the gauge, for context. */
  detailText: string;
}

export type SignalProgress =
  | { available: false; reason: "no-data" | "has-position" }
  | {
      available: true;
      /** When the strategy evaluated the evidence behind the gauges. */
      evaluatedAt: number;
      gauges: SignalGauge[];
      /** Bottleneck (minimum) gauge progress, 0–100. */
      overall: number;
      phase: SignalPhase;
      allMet: boolean;
    };

/** EMA approach window: EMA spread distance, as % of price. */
export const EMA_WINDOW_PCT = 1;
/** RSI approach window: distance to the oversold line, in RSI points. */
export const RSI_WINDOW_POINTS = 10;
/** MACD approach window: histogram improvement per candle, in ATR. */
export const MACD_WINDOW_ATR = 0.25;
/** Overall progress at/above which the droplet starts to tremble. */
export const ALMOST_THRESHOLD = 85;

const clampProgress = (v: number, met: boolean) =>
  met ? 100 : Math.max(0, Math.min(99, Math.round(v)));
const pct = (v: number, digits: number) =>
  `${v.toFixed(digits)}%`;

export function signalProgress(
  signal: SignalTelemetry | null | undefined,
): SignalProgress {
  if (!signal) return { available: false, reason: "no-data" };
  // With a position open, the next decision that matters is the exit
  // (stop-loss / take-profit), not a new BUY entry. Showing BUY
  // approach gauges then would misrepresent what the bot is waiting
  // for, so they are hidden rather than reinterpreted.
  if (signal.hasPosition) return { available: false, reason: "has-position" };

  const { current: cur, previous: prev, thresholds, price } = signal;
  const cond = signal.conditions;

  // 1. EMA: EMA20 must cross above EMA50.
  const spreadPct = ((cur.ema20 - cur.ema50) / price) * 100;
  const ema: SignalGauge = {
    id: "ema",
    label: "EMA上昇",
    met: cond.emaUp,
    progress: clampProgress(
      100 * (1 + spreadPct / EMA_WINDOW_PCT),
      cond.emaUp,
    ),
    remainingText: cond.emaUp
      ? ""
      : `EMA20がEMA50まで あと${pct(-spreadPct, 2)}`,
    detailText: `EMA20 ${cur.ema20.toFixed(4)} / EMA50 ${cur.ema50.toFixed(4)}`,
  };

  // 2. RSI recovery: the cross needs previous RSI <= oversold and
  // current RSI > oversold. Until the cross happens, the distance to
  // the oversold line is what remains — from below (RSI must rise back
  // out of the zone on the next candle) or from above (RSI must first
  // come back down to the zone to arm the recovery).
  const oversold = thresholds.oversold;
  const rsiDistance = Math.abs(cur.rsi - oversold);
  const rsiBelow = cur.rsi <= oversold;
  const rsi: SignalGauge = {
    id: "rsi",
    label: "RSI回復",
    met: cond.rsiRecovery,
    progress: clampProgress(
      100 * (1 - rsiDistance / RSI_WINDOW_POINTS),
      cond.rsiRecovery,
    ),
    remainingText: cond.rsiRecovery
      ? ""
      : rsiBelow
        ? `RSI あと${rsiDistance.toFixed(1)}ポイント上昇で売られすぎ圏を上抜け`
        : `RSI あと${rsiDistance.toFixed(1)}ポイント低下で売られすぎ圏（反発の起点）`,
    detailText: `RSI ${cur.rsi.toFixed(1)}（売られすぎライン ${oversold}・前足 ${prev.rsi.toFixed(1)}）`,
  };

  // 3. MACD: the histogram must be improving vs the previous candle.
  // The remaining distance is the slope itself: how much the change
  // must improve to turn positive, normalised by ATR.
  const histChange = cur.histogram - prev.histogram;
  const histChangeAtr = cur.atr > 0 ? histChange / cur.atr : 0;
  const macd: SignalGauge = {
    id: "macd",
    label: "MACD改善",
    met: cond.histogramImproving,
    progress: clampProgress(
      100 * (1 + histChangeAtr / MACD_WINDOW_ATR),
      cond.histogramImproving,
    ),
    remainingText: cond.histogramImproving
      ? ""
      : `ヒストグラムの変化 あと${(-histChange).toFixed(4)} 上向きに転じれば成立`,
    detailText: `ヒストグラム ${cur.histogram.toFixed(4)}（前足 ${prev.histogram.toFixed(4)}）`,
  };

  const gauges = [ema, rsi, macd];
  const overall = Math.min(...gauges.map((g) => g.progress));
  const allMet = gauges.every((g) => g.met);
  return {
    available: true,
    evaluatedAt: signal.evaluatedAt,
    gauges,
    overall,
    allMet,
    phase: allMet
      ? "ready"
      : overall >= ALMOST_THRESHOLD
        ? "almost"
        : overall >= 55
          ? "approaching"
          : "far",
  };
}
