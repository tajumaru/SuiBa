/**
 * The asset curve's model: the worker's recorded equity
 * snapshots (hourly, 30 days — see downsampleEquityCurve in
 * the worker), sliced to a display range. The y-axis hugs the
 * range's actual span, so the small real moves of a mostly
 * cash portfolio become visible instead of rounding away.
 */

export interface EquityPoint {
  t: number;
  equity: number;
  attribution?:
    | { realized: number; unrealized: number }
    | { issue: "history" | "reconciliation" };
}

export type EquityRangeKey = "24h" | "7d" | "30d";

export const EQUITY_RANGES: {
  key: EquityRangeKey;
  label: string;
  ms: number;
}[] = [
  { key: "24h", label: "24時間", ms: 24 * 3600 * 1000 },
  { key: "7d", label: "7日", ms: 7 * 24 * 3600 * 1000 },
  { key: "30d", label: "30日", ms: 30 * 24 * 3600 * 1000 },
];

export interface EquityCurveModel {
  points: EquityPoint[];
  min: number;
  max: number;
  first: number;
  last: number;
  delta: number;
  deltaPct: number | null;
  breakdown: { realized: number; holding: number } | null;
  breakdownIssue: "history" | "reconciliation" | null;
  partialPeriod: boolean;
}

export function equityCurveModel(
  points: readonly EquityPoint[],
  range: EquityRangeKey,
  now: number,
): EquityCurveModel | null {
  const ms = EQUITY_RANGES.find((r) => r.key === range)?.ms ?? 0;
  const pts = points.filter(
    (p) => p.t >= now - ms && Number.isFinite(p.equity),
  );
  if (pts.length < 2) return null;
  const values = pts.map((p) => p.equity);
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  const start = pts[0].attribution,
    end = pts.at(-1)!.attribution;
  let breakdown: EquityCurveModel["breakdown"] = null;
  let breakdownIssue: EquityCurveModel["breakdownIssue"] = "history";
  if (start && end && !("issue" in start) && !("issue" in end)) {
    const realized = end.realized - start.realized;
    const holding = end.unrealized - start.unrealized;
    if (
      [realized, holding].every(Number.isFinite) &&
      Math.abs(realized + holding - delta) <= 0.00001
    ) {
      breakdown = { realized, holding };
      breakdownIssue = null;
    } else breakdownIssue = "reconciliation";
  } else if (
    (start && "issue" in start && start.issue === "reconciliation") ||
    (end && "issue" in end && end.issue === "reconciliation")
  ) {
    breakdownIssue = "reconciliation";
  }
  return {
    points: pts,
    min: Math.min(...values),
    max: Math.max(...values),
    first,
    last,
    delta,
    deltaPct: first !== 0 ? (delta / first) * 100 : null,
    breakdown,
    breakdownIssue,
    // Hourly sampling normally starts within one hour of the requested edge.
    partialPeriod: pts[0].t > now - ms + 3600000,
  };
}

export function formatDelta(delta: number, deltaPct: number | null): string {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  const base = `${sign}${Math.abs(delta).toFixed(2)}`;
  return deltaPct == null
    ? base
    : `${base}（${deltaPct > 0 ? "+" : deltaPct < 0 ? "-" : ""}${Math.abs(deltaPct).toFixed(2)}%）`;
}
