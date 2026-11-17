import comparison from "../../../packages/shared/src/shadow-comparison.json" with {
  type: "json",
};
import { dayKey } from "../../../packages/shared/src/index.ts";
import type { BotDatabase } from "../../../packages/database/src/index.ts";

type Conditions = Record<string, unknown>;
type StrategyRecord = {
  evidence?: {
    candleTimestamp?: unknown;
    conditions?: Conditions;
  };
};
type ShadowRecord = {
  cycleId?: unknown;
  candleTimestamp?: unknown;
  status?: unknown;
  action?: unknown;
  price?: unknown;
  snapshot?: {
    evidence?: { inputs?: { price?: unknown } };
  };
};

export type ShadowTodaySummary = {
  total: number;
  aiOnlyBuy: number;
  errors: number;
  lastDecisionAt: number | null;
};

/** The registered base predicate and four-way truth table are shared with
 * docker/run-review.py through shadow-comparison.json. */
export function shadowRuleBuy(conditions: Conditions): boolean {
  return (
    comparison.coreConditions.every((key) => conditions[key] === true) &&
    comparison.volumeGate.requiredTrue.every(
      (key) => conditions[key] === true,
    ) &&
    comparison.volumeGate.requiredFalse.every(
      (key) => conditions[key] !== true,
    )
  );
}

export function shadowTodaySummary(
  db: BotDatabase,
  now = Date.now(),
): ShadowTodaySummary {
  const from = Date.parse(`${dayKey(now)}T00:00:00.000Z`),
    until = from + 86400000 - 1,
    shadows = db.range<ShadowRecord>("shadow_decisions", from, until),
    byCycle = new Map<string, StrategyRecord>();

  // strategy_decisions stores its correlation id in the SQL id, not JSON.
  // Shadow records do carry cycleId, so read the matching rows without copying
  // any model response fields into the API summary.
  const joinedRules = db.shadowRuleConditions(from, until);
  for (const [cycleId, rule] of joinedRules) byCycle.set(cycleId, rule);

  let aiOnlyBuy = 0;
  for (const row of shadows) {
    if (row.status !== "OK" || row.action !== "BUY") continue;
    const rule =
      typeof row.cycleId === "string" ? byCycle.get(row.cycleId) : undefined;
    const price = row.price ?? row.snapshot?.evidence?.inputs?.price;
    if (
      !rule ||
      row.candleTimestamp !== rule.evidence?.candleTimestamp ||
      typeof price !== "number" ||
      !Number.isFinite(price) ||
      price <= 0
    )
      continue;
    const ruleBuy = shadowRuleBuy(rule.evidence?.conditions ?? {});
    const group = comparison.groups.find(
      (candidate) =>
        candidate.action === row.action && candidate.ruleBuy === ruleBuy,
    );
    if (group?.key === "ai_only") aiOnlyBuy++;
  }
  return {
    total: shadows.length,
    aiOnlyBuy,
    errors: shadows.filter((row) => row.status === "ERROR").length,
    lastDecisionAt: db.shadowLastDecision(),
  };
}
