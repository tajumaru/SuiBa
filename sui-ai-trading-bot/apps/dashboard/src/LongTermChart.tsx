import { useMemo } from "react";
import type { DailyCandle } from "../../../packages/shared/src/index.ts";
import {
  longTermLevels,
  longTermTrend,
  spreadLabelYs,
  toWeekly,
} from "./longTermLevels.ts";

/**
 * The long-term map: two years of weekly candles with the
 * mechanically computed landmarks — period opens, the
 * period's high and low, and one live trend line. A viewing
 * layer over display-only daily data (Coinbase SUI-USD, see
 * the note under the chart); it feeds nothing.
 */

const W = 560;
const H = 240;
const PAD_R = 92; // label column
const FUTURE_WEEKS = 13;

const priceText = (v: number) =>
  v >= 100 ? v.toFixed(1) : v >= 1 ? v.toFixed(3) : v.toFixed(4);
const pctText = (f: number) =>
  `${f >= 0 ? "+" : ""}${(f * 100).toFixed(1)}%`;

export function LongTermChart({
  daily,
  price,
}: {
  daily: readonly DailyCandle[];
  /** The bot's own current price, for the now-line and the
   * distance column; falls back to the last daily close. */
  price: number | null;
}) {
  const model = useMemo(() => {
    const weekly = toWeekly(daily);
    if (weekly.length < 8) return null;
    const levels = longTermLevels(daily);
    const trend = longTermTrend(daily);
    const nowPrice = price ?? daily.at(-1)?.close ?? null;
    return { weekly, levels, trend, nowPrice };
  }, [daily, price]);
  if (!model) return null;
  const { weekly, levels, trend, nowPrice } = model;

  const plotW = W - PAD_R - 4;
  const firstT = weekly[0].timestamp;
  const lastT = weekly.at(-1)!.timestamp;
  const weekSec = 7 * 86400;
  const endT = lastT + FUTURE_WEEKS * weekSec;
  let lo = Infinity,
    hi = -Infinity;
  for (const c of weekly) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  for (const l of levels) {
    if (l.price < lo) lo = l.price;
    if (l.price > hi) hi = l.price;
  }
  const span = hi - lo || 1;
  lo -= span * 0.04;
  hi += span * 0.04;
  const X = (t: number) => 4 + ((t - firstT) / (endT - firstT)) * plotW;
  const Y = (v: number) => 6 + (1 - (v - lo) / (hi - lo)) * (H - 12);
  const barW = Math.max(1.5, (plotW / ((endT - firstT) / weekSec)) * 0.68);

  // Label baselines, spread so neighbouring labels never
  // pile onto each other when two landmarks sit at nearly
  // the same price (the current price over the month open is
  // the usual case). Lines keep their true prices.
  const nowInRange = nowPrice != null && nowPrice >= lo && nowPrice <= hi;
  const labelYs = spreadLabelYs(
    [
      ...levels.map((l) => Y(l.price) + 3),
      ...(nowInRange ? [Y(nowPrice!) + 3] : []),
    ],
    11,
    9,
    H - 3,
  );
  const levelLabelY = new Map(levels.map((l, i) => [l.kind, labelYs[i]]));
  const nowLabelY = nowInRange ? labelYs[labelYs.length - 1] : null;

  const levelColor = (kind: string) =>
    kind === "high" ? "#43dfb2" : kind === "low" ? "#f77d8f" : "#64b5ff";

  // Trend segment, extended to the domain end but stopped
  // where it would leave the price range.
  let trendSeg: { x1: number; y1: number; x2: number; y2: number } | null =
    null;
  if (trend) {
    const at = (t: number) =>
      trend.p1 + ((trend.p2 - trend.p1) * (t - trend.t1)) / (trend.t2 - trend.t1);
    let tEnd = endT;
    const vEnd = at(endT);
    if (vEnd > hi || vEnd < lo) {
      const target = vEnd > hi ? hi : lo;
      tEnd =
        trend.t1 +
        ((target - trend.p1) * (trend.t2 - trend.t1)) / (trend.p2 - trend.p1);
    }
    trendSeg = {
      x1: X(trend.t1),
      y1: Y(trend.p1),
      x2: X(tEnd),
      y2: Y(at(tEnd)),
    };
  }

  return (
    <div className="long-term-map">
      <svg
        className="long-term-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="長期マップ（週足と水準）"
      >
        {weekly.map((c) => {
          const x = X(c.timestamp);
          const up = c.close >= c.open;
          const color = up ? "#43dfb2" : "#f77d8f";
          const yTop = Y(Math.max(c.open, c.close));
          const yBot = Y(Math.min(c.open, c.close));
          return (
            <g key={c.timestamp}>
              <line
                x1={x + barW / 2}
                x2={x + barW / 2}
                y1={Y(c.high)}
                y2={Y(c.low)}
                stroke={color}
                strokeWidth={0.8}
                opacity={0.75}
              />
              <rect
                x={x}
                y={yTop}
                width={barW}
                height={Math.max(1, yBot - yTop)}
                fill={color}
                opacity={0.9}
              />
            </g>
          );
        })}
        {trendSeg && (
          <line
            {...trendSeg}
            stroke="#dce8f0"
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.65}
          />
        )}
        {levels.map((l) => (
          <g key={l.kind}>
            <line
              x1={4}
              x2={4 + plotW}
              y1={Y(l.price)}
              y2={Y(l.price)}
              stroke={levelColor(l.kind)}
              strokeWidth={0.8}
              strokeDasharray="5 4"
              opacity={0.8}
            />
            <text
              x={4 + plotW + 6}
              y={levelLabelY.get(l.kind)}
              fontSize={9.5}
              fill={levelColor(l.kind)}
            >
              {l.label} {priceText(l.price)}
            </text>
          </g>
        ))}
        {nowInRange && nowPrice != null && (
          <g>
            <line
              x1={4}
              x2={4 + plotW}
              y1={Y(nowPrice)}
              y2={Y(nowPrice)}
              stroke="#edc980"
              strokeWidth={0.8}
              strokeDasharray="2 3"
            />
            <text
              x={4 + plotW + 6}
              y={nowLabelY!}
              fontSize={9.5}
              fill="#edc980"
            >
              現在 {priceText(nowPrice)}
            </text>
          </g>
        )}
      </svg>
      {nowPrice != null && (
        <p className="long-term-distances">
          {levels.map((l) => (
            <span key={l.kind} className="long-term-distance">
              {l.label}まで {pctText(l.price / nowPrice - 1)}
            </span>
          ))}
        </p>
      )}
      <p className="long-term-note">
        日足は Coinbase（SUI/USD）の表示用データから自動計算した水準。白破線は
        高値・安値を結んだトレンド線。売買や予測には使わない。
      </p>
    </div>
  );
}
