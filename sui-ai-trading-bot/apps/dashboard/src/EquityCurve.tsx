import { useMemo, useState } from "react";
import {
  EQUITY_RANGES,
  equityCurveModel,
  formatDelta,
  type EquityPoint,
  type EquityRangeKey,
} from "./equityCurve.ts";

/**
 * The asset curve on the Overview tab, under the summary
 * cards: the bot's recorded equity over the last 24 hours /
 * 7 days / 30 days, auto-scaled to its real span. The points
 * are the worker's own per-cycle snapshots, so the line also
 * covers the hours the app was closed.
 */

const W = 520;
const H = 110;

export function EquityCurve({
  points,
}: {
  points: readonly EquityPoint[];
}) {
  const [range, setRange] = useState<EquityRangeKey>("7d");
  const model = useMemo(
    () => equityCurveModel(points, range, Date.now()),
    [points, range],
  );
  const rangeLabel = EQUITY_RANGES.find((r) => r.key === range)?.label ?? "";
  let body: React.ReactNode;
  if (!model) {
    body = <p className="equity-curve-empty">記録が貯まるまで集計中</p>;
  } else {
    const span = model.max - model.min;
    const pad = span > 0 ? span * 0.15 : 0.5;
    const lo = model.min - pad;
    const hi = model.max + pad;
    const X = (i: number) => (i / (model.points.length - 1)) * W;
    const Y = (v: number) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
    const line = model.points
      .map((p, i) => `${X(i).toFixed(1)},${Y(p.equity).toFixed(1)}`)
      .join(" ");
    body = (
      <>
        <svg
          className="equity-curve-svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polyline
            points={`0,${Y(model.first)} ${W},${Y(model.first)}`}
            fill="none"
            stroke="#2a3a4c"
            strokeDasharray="3 4"
          />
          <polygon
            points={`0,${H} ${line} ${W},${H}`}
            fill="rgba(67,223,178,0.10)"
          />
          <polyline points={line} fill="none" stroke="#43dfb2" strokeWidth="1.6" />
        </svg>
        <div className="equity-curve-axis">
          <span>最小 {model.min.toFixed(2)}</span>
          <span>開始 {model.first.toFixed(2)}</span>
          <span>最大 {model.max.toFixed(2)}</span>
        </div>
      </>
    );
  }
  return (
    <section className="equity-curve" aria-label="資産の推移">
      <div className="equity-curve-head">
        <h3>資産の推移</h3>
        {model && (
          <span
            className={`equity-curve-delta ${model.delta >= 0 ? "pos" : "neg"}`}
          >
            {rangeLabel}で {formatDelta(model.delta, model.deltaPct)}
          </span>
        )}
      </div>
      <div className="equity-curve-tabs" role="group" aria-label="資産グラフの期間">
        {EQUITY_RANGES.map((r) => (
          <button
            key={r.key}
            aria-pressed={range === r.key}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>
      {body}
    </section>
  );
}
