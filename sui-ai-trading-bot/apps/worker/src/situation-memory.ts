import type { BotDatabase } from "../../../packages/database/src/index.ts";
import type {
  Candle,
  TradingDecision,
} from "../../../packages/shared/src/index.ts";
import { shadowRuleBuy } from "./shadow-summary.ts";

export const SITUATION_MEMORY_MIN_SAMPLES = 30;
export const SITUATION_MEMORY_BIAS_PCT = 0.3;
export const REVIEW_ROUND_TRIP_COST_PCT = 0.6;

export type SituationRegime = "up" | "down" | "range" | "unknown";
export type SituationKind = "rule-buy" | "near-buy" | "shadow-ai-buy";
export type SituationMemory = {
  key: string;
  regime: SituationRegime;
  kind: SituationKind;
  evaluatedAt: number;
  n: number;
  mean4hPct: number;
  positiveRate: number;
  recall?: string;
};

type DecisionRow = { id: string; timestamp: number; decision: TradingDecision };
type ShadowRow = {
  cycleId?: string;
  candleTimestamp?: number;
  action?: string;
  status?: string;
  evaluatedAt?: number;
  snapshot?: { evaluatedAt?: number; candle?: { close?: number } };
};

function regimes(candles: readonly Candle[]) {
  const ordered = [...candles]
    .filter((c) => c.timeframe === 300 && Number.isFinite(c.close))
    .sort((a, b) => a.timestamp - b.timestamp);
  const ema = new Map<number, number>();
  let value: number | undefined;
  for (const candle of ordered) {
    value =
      value === undefined
        ? candle.close
        : value + (2 / 51) * (candle.close - value);
    ema.set(candle.timestamp, value);
  }
  const atOrBefore = (at: number) => {
    let lo = 0,
      hi = ordered.length - 1,
      found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ordered[mid].timestamp <= at) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  return {
    closeAt: new Map(ordered.map((c) => [c.timestamp, c.close])),
    at(timestamp: number): SituationRegime {
      const i = atOrBefore(timestamp),
        j = atOrBefore(timestamp - 86400);
      if (i < 0 || j < 0 || ordered[j].timestamp > timestamp - 86400 + 900)
        return "unknown";
      const current = ema.get(ordered[i].timestamp),
        prior = ema.get(ordered[j].timestamp);
      if (current === undefined || prior === undefined || prior <= 0)
        return "unknown";
      const slope = (current / prior - 1) * 100;
      return slope >= 0.5 ? "up" : slope <= -0.5 ? "down" : "range";
    },
  };
}

function ruleKind(decision: TradingDecision): SituationKind | null {
  const conditions = decision.evidence?.conditions;
  if (!conditions) return null;
  const met = ["emaUp", "rsiRecovery", "histogramImproving"].filter(
    (key) => conditions[key as keyof typeof conditions] === true,
  ).length;
  if (decision.action === "BUY") return "rule-buy";
  return met === 2 ? "near-buy" : null;
}

/** Uses the daily review's close-seeded EMA50 regimes and exact, cost-deducted +4h return. */
export function aggregateSituationMemory(
  decisions: readonly DecisionRow[],
  shadows: readonly ShadowRow[],
  candles: readonly Candle[],
): SituationMemory | null {
  const series = regimes(candles);
  const rules = new Map(decisions.map((row) => [row.id, row]));
  const samples: {
    kind: SituationKind;
    regime: SituationRegime;
    net: number;
  }[] = [];
  let current: {
    kind: SituationKind;
    regime: SituationRegime;
    evaluatedAt: number;
  } | null = null;
  for (const row of decisions) {
    const evidence = row.decision.evidence,
      kind = ruleKind(row.decision);
    const timestamp = evidence?.candleTimestamp,
      price = evidence?.inputs.price;
    if (
      !evidence ||
      !kind ||
      typeof timestamp !== "number" ||
      typeof price !== "number" ||
      price <= 0
    )
      continue;
    const regime = series.at(timestamp),
      evaluatedAt = evidence.evaluatedAt;
    if (!current || evaluatedAt > current.evaluatedAt)
      current = { kind, regime, evaluatedAt };
    const result = series.closeAt.get(timestamp + 4 * 3600);
    if (result !== undefined)
      samples.push({
        kind,
        regime,
        net: (result / price - 1) * 100 - REVIEW_ROUND_TRIP_COST_PCT,
      });
  }
  for (const shadow of shadows) {
    if (
      shadow.status !== "OK" ||
      shadow.action !== "BUY" ||
      typeof shadow.cycleId !== "string"
    )
      continue;
    const rule = rules.get(shadow.cycleId),
      evidence = rule?.decision.evidence;
    if (
      !evidence ||
      shadow.candleTimestamp !== evidence.candleTimestamp ||
      shadowRuleBuy(evidence.conditions)
    )
      continue;
    const timestamp = shadow.candleTimestamp,
      price = shadow.snapshot?.candle?.close ?? evidence.inputs.price;
    if (
      typeof timestamp !== "number" ||
      typeof price !== "number" ||
      price <= 0
    )
      continue;
    const regime = series.at(timestamp),
      evaluatedAt =
        shadow.evaluatedAt ??
        shadow.snapshot?.evaluatedAt ??
        evidence.evaluatedAt;
    if (!current || evaluatedAt >= current.evaluatedAt)
      current = { kind: "shadow-ai-buy", regime, evaluatedAt };
    const result = series.closeAt.get(timestamp + 4 * 3600);
    if (result !== undefined)
      samples.push({
        kind: "shadow-ai-buy",
        regime,
        net: (result / price - 1) * 100 - REVIEW_ROUND_TRIP_COST_PCT,
      });
  }
  if (!current) return null;
  const matched = samples.filter(
    (sample) =>
      sample.kind === current!.kind && sample.regime === current!.regime,
  );
  if (!matched.length) return null;
  return {
    ...current,
    key: `${current.regime}:${current.kind}`,
    n: matched.length,
    mean4hPct:
      matched.reduce((sum, sample) => sum + sample.net, 0) / matched.length,
    positiveRate:
      (matched.filter((sample) => sample.net > 0).length / matched.length) *
      100,
  };
}

export function refreshSituationMemory(
  db: BotDatabase,
): SituationMemory | null {
  const value = aggregateSituationMemory(
    db.situationDecisionRows(),
    db.history<ShadowRow>("shadow_decisions", 10000),
    db.candles(300),
  );
  db.set("situation_memory", value);
  return value;
}
