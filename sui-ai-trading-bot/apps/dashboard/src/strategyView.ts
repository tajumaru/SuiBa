import { z } from "zod";
import {
  settingsSchema,
  type Settings,
} from "../../../packages/shared/src/index.ts";
import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import { DECISION_FRESH_MS } from "./agentNarration.ts";

/**
 * Pure view logic for the diagram-first strategy tab. Everything here
 * is derived from records the app already receives: the decision
 * evidence telemetry (the same fail-closed copy the narration reads)
 * and the saved settings. Nothing is estimated or invented — a value
 * that is missing, stale, or not finite yields an explicit "unknown"
 * state instead of a guessed colour.
 */

/**
 * The same freshness window the narration applies to decision
 * evidence: both the evaluation time and the candle it evaluated must
 * be inside DECISION_FRESH_MS, and every number the cards draw must
 * be finite (and positive where a price-like value is required).
 */
export function isFreshDecision(
  dec: DecisionTelemetry | null | undefined,
  now: number,
): dec is DecisionTelemetry {
  if (dec == null) return false;
  if (
    !(
      dec.evaluatedAt > 0 &&
      dec.evaluatedAt <= now &&
      now - dec.evaluatedAt <= DECISION_FRESH_MS &&
      dec.candleTimestamp > 0 &&
      dec.candleTimestamp <= dec.evaluatedAt &&
      now - dec.candleTimestamp <= DECISION_FRESH_MS
    )
  )
    return false;
  return (
    Number.isFinite(dec.price) &&
    dec.price > 0 &&
    Number.isFinite(dec.ema20) &&
    dec.ema20 > 0 &&
    Number.isFinite(dec.ema50) &&
    dec.ema50 > 0 &&
    Number.isFinite(dec.rsi) &&
    dec.rsi >= 0 &&
    dec.rsi <= 100 &&
    Number.isFinite(dec.previousRsi) &&
    dec.previousRsi >= 0 &&
    dec.previousRsi <= 100 &&
    Number.isFinite(dec.histogram) &&
    Number.isFinite(dec.previousHistogram) &&
    Number.isFinite(dec.volumeChange) &&
    Number.isFinite(dec.oversold) &&
    Number.isFinite(dec.overbought)
  );
}

/** One narratable indicator sample, copied verbatim from telemetry. */
export interface IndicatorPoint {
  evaluatedAt: number;
  price: number;
  ema20: number;
  ema50: number;
  rsi: number;
  histogram: number;
}

export const MAX_INDICATOR_HISTORY = 12;

/**
 * Append one history point per NEW decision. Polls re-deliver the
 * same snapshot many times, so anything whose evaluatedAt is not
 * newer than the last recorded point (a re-delivery, a stale or an
 * out-of-order sample) leaves the history untouched — the mini
 * charts only ever draw decisions that actually happened, in order.
 */
export function appendIndicatorPoint(
  history: readonly IndicatorPoint[],
  dec: DecisionTelemetry | null | undefined,
  now: number,
): IndicatorPoint[] {
  if (!isFreshDecision(dec, now)) return [...history];
  const last = history.at(-1);
  if (last && dec.evaluatedAt <= last.evaluatedAt) return [...history];
  const point: IndicatorPoint = {
    evaluatedAt: dec.evaluatedAt,
    price: dec.price,
    ema20: dec.ema20,
    ema50: dec.ema50,
    rsi: dec.rsi,
    histogram: dec.histogram,
  };
  return [...history, point].slice(-MAX_INDICATOR_HISTORY);
}

/** History points plus the current decision, oldest first, deduped. */
function seriesPoints(
  history: readonly IndicatorPoint[],
  dec: DecisionTelemetry,
): IndicatorPoint[] {
  const past = history.filter((p) => p.evaluatedAt < dec.evaluatedAt);
  return [
    ...past,
    {
      evaluatedAt: dec.evaluatedAt,
      price: dec.price,
      ema20: dec.ema20,
      ema50: dec.ema50,
      rsi: dec.rsi,
      histogram: dec.histogram,
    },
  ].slice(-MAX_INDICATOR_HISTORY);
}

export type EmaVizData =
  | { kind: "series"; ema20: number[]; ema50: number[] }
  | { kind: "levels"; price: number; ema20: number; ema50: number }
  | { kind: "none" };

/**
 * EMA mini chart data. With two or more recorded decisions the card
 * draws the real EMA20 / EMA50 lines over time; before that it falls
 * back to a level view of the three recorded values (price, EMA20,
 * EMA50) so the card never fabricates a past the client did not see.
 */
export function emaVizData(
  history: readonly IndicatorPoint[],
  dec: DecisionTelemetry | null | undefined,
  now: number,
): EmaVizData {
  if (!isFreshDecision(dec, now)) return { kind: "none" };
  const points = seriesPoints(history, dec);
  if (points.length >= 2)
    return {
      kind: "series",
      ema20: points.map((p) => p.ema20),
      ema50: points.map((p) => p.ema50),
    };
  return {
    kind: "levels",
    price: dec.price,
    ema20: dec.ema20,
    ema50: dec.ema50,
  };
}

export const MAX_MACD_BARS = 8;

/**
 * MACD histogram bars, oldest first. Bars come from the accumulated
 * history; with a single recorded decision the pair is the recorded
 * previous histogram and the current one — both real values from the
 * same evidence — so the direction of travel is visible immediately.
 */
export function macdBars(
  history: readonly IndicatorPoint[],
  dec: DecisionTelemetry | null | undefined,
  now: number,
): number[] {
  if (!isFreshDecision(dec, now)) return [];
  const bars = seriesPoints(history, dec).map((p) => p.histogram);
  if (bars.length < 2) return [dec.previousHistogram, dec.histogram];
  return bars.slice(-MAX_MACD_BARS);
}

export type ConditionState = "met" | "unmet" | "unknown";
export type VolumeState = "ok" | "exceeded" | "unknown";

export interface StrategyConditions {
  /** EMA trend: EMA20 above EMA50 (conditions.emaUp). */
  ema: {
    state: ConditionState;
    ema20: number | null;
    ema50: number | null;
    /** Signed gap (EMA20 − EMA50) as a share of price. */
    gapPct: number | null;
  };
  /** RSI recovery: dipped to/below the buy line, then rose above it. */
  rsi: {
    state: ConditionState;
    rsi: number | null;
    previousRsi: number | null;
    oversold: number | null;
    overbought: number | null;
  };
  /** MACD momentum: histogram improving on the previous candle. */
  macd: {
    state: ConditionState;
    histogram: number | null;
    previousHistogram: number | null;
  };
  /**
   * Volume guard: the strategy rejects the cycle when
   * |volumeChange| exceeds the saved limit, so the card judges by
   * exactly that recorded comparison. `multiple` is the latest
   * candle's volume as a multiple of the previous one (1 + change).
   */
  volume: {
    state: VolumeState;
    multiple: number | null;
    limit: number;
  };
  /** Entry conditions met, 0–3; null while evidence is unavailable. */
  metCount: number | null;
}

const UNKNOWN_CONDITIONS = (limit: number): StrategyConditions => ({
  ema: { state: "unknown", ema20: null, ema50: null, gapPct: null },
  rsi: {
    state: "unknown",
    rsi: null,
    previousRsi: null,
    oversold: null,
    overbought: null,
  },
  macd: { state: "unknown", histogram: null, previousHistogram: null },
  volume: { state: "unknown", multiple: null, limit },
  metCount: null,
});

/**
 * Condition card states come only from the recorded condition flags
 * in the telemetry — the same flags the strategy itself evaluated —
 * never from re-computing the rules in the browser.
 */
export function strategyConditions(
  dec: DecisionTelemetry | null | undefined,
  maxVolumeChange: number,
  now: number,
): StrategyConditions {
  if (!isFreshDecision(dec, now)) return UNKNOWN_CONDITIONS(maxVolumeChange);
  const cond = dec.conditions;
  return {
    ema: {
      state: cond.emaUp ? "met" : "unmet",
      ema20: dec.ema20,
      ema50: dec.ema50,
      gapPct: (dec.ema20 - dec.ema50) / dec.price,
    },
    rsi: {
      state: cond.rsiRecovery ? "met" : "unmet",
      rsi: dec.rsi,
      previousRsi: dec.previousRsi,
      oversold: dec.oversold,
      overbought: dec.overbought,
    },
    macd: {
      state: cond.histogramImproving ? "met" : "unmet",
      histogram: dec.histogram,
      previousHistogram: dec.previousHistogram,
    },
    volume: {
      state:
        Math.abs(dec.volumeChange) > maxVolumeChange ? "exceeded" : "ok",
      multiple: 1 + dec.volumeChange,
      limit: maxVolumeChange,
    },
    metCount: [cond.emaUp, cond.rsiRecovery, cond.histogramImproving].filter(
      Boolean,
    ).length,
  };
}

/** Colour family of the result panel for a recorded decision action. */
export function verdictTone(
  action: string | null | undefined,
): "buy" | "sell" | "wait" | "none" {
  return action === "BUY"
    ? "buy"
    : action === "SELL"
      ? "sell"
      : action === "WAIT"
        ? "wait"
        : "none";
}

/* ------------------------------------------------------------------ */
/* Strategy parameter groups and their scale bars                     */
/* ------------------------------------------------------------------ */

export interface SettingRange {
  min: number;
  max: number;
}

let rangeCache: Record<string, SettingRange> | null = null;

/**
 * Selectable range of a setting, read out of the shared zod schema
 * (via its JSON Schema form) so the scale bars can never drift from
 * the values the settings page actually enforces. `positive()` shows
 * up as an exclusive minimum of 0, which is the scale's floor anyway.
 */
export function settingRange(key: keyof Settings): SettingRange {
  if (!rangeCache) {
    rangeCache = {};
    const json = z.toJSONSchema(settingsSchema) as {
      properties?: Record<
        string,
        {
          minimum?: number;
          maximum?: number;
          exclusiveMinimum?: number;
          exclusiveMaximum?: number;
        }
      >;
    };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      const min = prop.minimum ?? prop.exclusiveMinimum ?? 0;
      const max = prop.maximum ?? prop.exclusiveMaximum;
      if (Number.isFinite(min) && max != null && Number.isFinite(max))
        rangeCache[name] = { min, max };
    }
  }
  return rangeCache[key] ?? { min: 0, max: 1 };
}

/** Fraction 0–1 of `value` along [min, max], clamped, fail-closed. */
export function scaleFraction(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !(max > min)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

export interface StrategyParamDef {
  key: keyof Settings;
  /** Draw the scale bar under the value. */
  bar: boolean;
  /**
   * Display domain in raw setting units when the natural whole is
   * wider than the selectable range (RSI points run 0–100, ratios
   * run 0–1). Null means the domain is the selectable range itself.
   */
  domain: readonly [number, number] | null;
}

export interface StrategyParamGroup {
  id: string;
  title: string;
  description: string;
  params: readonly StrategyParamDef[];
}

/**
 * Every field of the settings page appears in exactly one group (the
 * profit-guard switch itself is shown as the ProfitGuard card's
 * status, not as a numeric row).
 */
export const STRATEGY_PARAM_GROUPS: readonly StrategyParamGroup[] = [
  {
    id: "entry",
    title: "買い条件",
    description: "買うかどうかを決める物差し",
    params: [
      { key: "oversold", bar: true, domain: [0, 100] },
      { key: "maxVolumeChange", bar: true, domain: null },
      { key: "intervalMs", bar: false, domain: null },
    ],
  },
  {
    id: "risk",
    title: "売り・リスク",
    description: "手放す目安と、守りの上限",
    params: [
      { key: "overbought", bar: true, domain: [0, 100] },
      { key: "stopLossPct", bar: true, domain: null },
      { key: "takeProfitPct", bar: true, domain: null },
      { key: "maxOrder", bar: true, domain: null },
      { key: "dailyBuyLimit", bar: true, domain: null },
      { key: "maxHoldingRatio", bar: true, domain: [0, 1] },
      { key: "dailyLossPct", bar: true, domain: null },
      { key: "maxSlippage", bar: true, domain: null },
    ],
  },
  {
    id: "profit-guard",
    title: "ProfitGuard（利益保護）",
    description: "コストを引いても利益が残る時だけ売る仕組み",
    params: [
      { key: "minNetProfitUsdc", bar: true, domain: null },
      { key: "minNetProfitPct", bar: true, domain: [0, 1] },
      { key: "feeRate", bar: true, domain: null },
      { key: "gasUsdc", bar: true, domain: null },
    ],
  },
];

export interface ParamScale {
  /** Raw value read from the saved settings. */
  value: number;
  domainMin: number;
  domainMax: number;
  /** Selectable band inside the domain, as fractions 0–1. */
  bandLeft: number;
  bandWidth: number;
  /** Current value marker, as a fraction 0–1. */
  marker: number;
}

/** Scale geometry for one parameter row, all in raw setting units. */
export function paramScale(
  settings: Settings,
  def: StrategyParamDef,
): ParamScale {
  const range = settingRange(def.key),
    value = Number(settings[def.key]),
    domainMin = def.domain?.[0] ?? range.min,
    domainMax = def.domain?.[1] ?? range.max,
    bandLeft = scaleFraction(range.min, domainMin, domainMax);
  return {
    value,
    domainMin,
    domainMax,
    bandLeft,
    bandWidth:
      scaleFraction(range.max, domainMin, domainMax) - bandLeft,
    marker: scaleFraction(value, domainMin, domainMax),
  };
}
