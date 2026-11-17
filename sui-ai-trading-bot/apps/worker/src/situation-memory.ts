import type { BotDatabase } from "../../../packages/database/src/index.ts";
import type {
  Candle,
  TradingDecision,
} from "../../../packages/shared/src/index.ts";
import { shadowRuleBuy } from "./shadow-summary.ts";

export const SITUATION_MEMORY_MIN_SAMPLES = 30;
export const SITUATION_MEMORY_BIAS_PCT = 0.3;
export const REVIEW_ROUND_TRIP_COST_PCT = 0.6;
export const DIP_REBOUND_ROUND_TRIP_COST_PCT = 0.2;
export const LIQUIDATION_SPIKE_MULTIPLIER = 5;
export const LIQUIDATION_SPIKE_MIN_USD = 100_000;

export type SituationRegime = "up" | "down" | "range" | "unknown";
export type SituationKind = "rule-buy" | "near-buy" | "shadow-ai-buy";
export type DecisionSituationMemory = {
  scene: "decision";
  key: string;
  regime: SituationRegime;
  kind: SituationKind;
  evaluatedAt: number;
  n: number;
  mean4hPct: number;
  positiveRate: number;
  recall?: string;
};
export type DipReboundPeriod = {
  period: string;
  n: number;
  mean24hPct: number;
  positiveRate: number;
};
export type DipReboundSituationMemory = {
  scene: "dip-rebound";
  key: string;
  evaluatedAt: number;
  n: number;
  mean24hPct: number;
  positiveRate: number;
  periods: DipReboundPeriod[];
};
export type LiquidationSpikeSituationMemory = {
  scene: "liquidation-spike";
  key: "liquidation-spike";
  evaluatedAt: number;
  n: number;
  mean24hPct: number;
  positiveRate: number;
  periods: DipReboundPeriod[];
  source: "Binance USD-M Futures (external reference)";
};
export type SituationMemory =
  | DecisionSituationMemory
  | DipReboundSituationMemory
  | LiquidationSpikeSituationMemory;

export type LiquidationBucket = {
  bucketAt: number;
  longUsd: number;
  shortUsd: number;
  count: number;
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
): DecisionSituationMemory | null {
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
    scene: "decision",
    key: `${current.regime}:${current.kind}`,
    n: matched.length,
    mean4hPct:
      matched.reduce((sum, sample) => sum + sample.net, 0) / matched.length,
    positiveRate:
      (matched.filter((sample) => sample.net > 0).length / matched.length) *
      100,
  };
}

/**
 * Finds the first 5-minute candle at or below a -3% exact 4-hour return.
 * Once found, another event is suppressed until three consecutive candles
 * are outside the condition. Missing 4-hour anchors do not re-arm the latch.
 */
export function dipReboundEvents(candles: readonly Candle[]): Candle[] {
  const ordered = [...candles]
    .filter(
      (c) => c.timeframe === 300 && Number.isFinite(c.close) && c.close > 0,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  const closeAt = new Map(ordered.map((c) => [c.timestamp, c.close]));
  const events: Candle[] = [];
  let armed = true;
  let falseCandles = 0;
  let previousTimestamp: number | undefined;
  for (const candle of ordered) {
    if (
      previousTimestamp !== undefined &&
      candle.timestamp !== previousTimestamp + 300
    )
      falseCandles = 0;
    previousTimestamp = candle.timestamp;
    const start = closeAt.get(candle.timestamp - 4 * 3600);
    if (start === undefined || start <= 0) {
      falseCandles = 0;
      continue;
    }
    const matches = (candle.close / start - 1) * 100 <= -3;
    if (matches) {
      if (armed) events.push(candle);
      armed = false;
      falseCandles = 0;
    } else if (!armed && ++falseCandles >= 3) {
      armed = true;
      falseCandles = 0;
    }
  }
  return events;
}

const utcPeriod = (timestamp: number) =>
  new Date(timestamp * 1000).toISOString().slice(0, 10);

function dipStats(
  samples: readonly { timestamp: number; net: number }[],
): Omit<DipReboundPeriod, "period"> {
  return {
    n: samples.length,
    mean24hPct:
      samples.reduce((sum, sample) => sum + sample.net, 0) / samples.length,
    positiveRate:
      (samples.filter((sample) => sample.net > 0).length / samples.length) *
      100,
  };
}

/** Display-only +24h outcome for the latest detected dip-rebound scene. */
export function aggregateDipReboundMemory(
  candles: readonly Candle[],
): DipReboundSituationMemory | null {
  const events = dipReboundEvents(candles);
  const current = events.at(-1);
  if (!current) return null;
  const closeAt = new Map(candles.map((c) => [c.timestamp, c.close]));
  const samples = events.flatMap((event) => {
    const result = closeAt.get(event.timestamp + 24 * 3600);
    return result === undefined
      ? []
      : [
          {
            timestamp: event.timestamp,
            net:
              (result / event.close - 1) * 100 -
              DIP_REBOUND_ROUND_TRIP_COST_PCT,
          },
        ];
  });
  if (!samples.length) return null;
  const grouped = new Map<string, typeof samples>();
  for (const sample of samples) {
    const period = utcPeriod(sample.timestamp);
    grouped.set(period, [...(grouped.get(period) ?? []), sample]);
  }
  return {
    scene: "dip-rebound",
    key: "dip-rebound",
    evaluatedAt: current.timestamp * 1000,
    ...dipStats(samples),
    periods: [...grouped].map(([period, periodSamples]) => ({
      period,
      ...dipStats(periodSamples),
    })),
  };
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function liquidationSpike(
  longUsd: number,
  priorFourHourTotals: readonly number[],
) {
  return (
    priorFourHourTotals.length > 0 &&
    longUsd >= LIQUIDATION_SPIKE_MIN_USD &&
    longUsd >= median(priorFourHourTotals) * LIQUIDATION_SPIKE_MULTIPLIER
  );
}

/** Display-only external-reference scene; never consumed by trading or shadow decisions. */
export function aggregateLiquidationSpikeMemory(
  candles: readonly Candle[],
  buckets: readonly LiquidationBucket[],
): LiquidationSpikeSituationMemory | null {
  const dips = dipReboundEvents(candles);
  const closeAt = new Map(candles.map((c) => [c.timestamp, c.close]));
  const longIn = (after: number, through: number) =>
    buckets
      .filter((b) => b.bucketAt > after && b.bucketAt <= through)
      .reduce((sum, b) => sum + b.longUsd, 0);
  const events = dips.filter((event) => {
    const current = longIn(event.timestamp - 4 * 3600, event.timestamp);
    const baseline = Array.from({ length: 12 }, (_, index) => {
      const end = event.timestamp - (index + 1) * 4 * 3600;
      return longIn(end - 4 * 3600, end);
    });
    return liquidationSpike(current, baseline);
  });
  const current = events.at(-1);
  if (!current) return null;
  const samples = events.flatMap((event) => {
    const result = closeAt.get(event.timestamp + 24 * 3600);
    return result === undefined
      ? []
      : [
          {
            timestamp: event.timestamp,
            net:
              (result / event.close - 1) * 100 -
              DIP_REBOUND_ROUND_TRIP_COST_PCT,
          },
        ];
  });
  if (!samples.length) return null;
  const grouped = new Map<string, typeof samples>();
  for (const sample of samples) {
    const period = utcPeriod(sample.timestamp);
    grouped.set(period, [...(grouped.get(period) ?? []), sample]);
  }
  return {
    scene: "liquidation-spike",
    key: "liquidation-spike",
    evaluatedAt: current.timestamp * 1000,
    ...dipStats(samples),
    periods: [...grouped].map(([period, periodSamples]) => ({
      period,
      ...dipStats(periodSamples),
    })),
    source: "Binance USD-M Futures (external reference)",
  };
}

export function refreshSituationMemory(
  db: BotDatabase,
): SituationMemory | null {
  const candles = db.candles(300);
  const decision = aggregateSituationMemory(
    db.situationDecisionRows(),
    db.history<ShadowRow>("shadow_decisions", 10000),
    candles,
  );
  const dip = aggregateDipReboundMemory(candles);
  const liquidation = aggregateLiquidationSpikeMemory(
    candles,
    db.liquidationBuckets(candles[0]?.timestamp ?? 0),
  );
  const value =
    [decision, dip, liquidation]
      .filter((item): item is SituationMemory => item !== null)
      .sort((a, b) => a.evaluatedAt - b.evaluatedAt)
      .at(-1) ?? null;
  db.set("situation_memory", value);
  return value;
}
