import type { Candle } from "../../../packages/shared/src/index.ts";
import type { ChartForecast } from "./chartForecast.ts";
import { forecastPalette } from "./chartForecast.ts";
import type { ForecastAnswerCheck } from "./forecastLog.ts";
import type { AnswerGhost, CrossingMark } from "./chartOverlayGeometry.ts";

/**
 * The price chart's SVG overlay groups, extracted from
 * PriceChart.tsx as pure render components: the forecast cone
 * with its touch line and sell-line crossing marks, the
 * answer-check ghost, and the hover readout. Geometry is
 * computed in chartOverlayGeometry.ts; these only draw it.
 */

type Scale = (v: number) => number;

export function ForecastOverlay({
  fc,
  fcCone,
  fcMid,
  fcPalette,
  crossingMarks,
  x,
  y,
  latestEnd,
}: {
  fc: ChartForecast;
  fcCone: string;
  fcMid: string;
  fcPalette: ReturnType<typeof forecastPalette>;
  crossingMarks: CrossingMark[];
  x: Scale;
  y: Scale;
  latestEnd: number;
}) {
  return (
    <g className="chart-forecast" aria-label="予測（模式）">
      <line
        x1={x(latestEnd)}
        x2={x(latestEnd)}
        y1="30"
        y2="215"
        stroke="#64b5ff"
        strokeDasharray="2 4"
        opacity="0.6"
      />
      <polygon points={fcCone} fill={fcPalette!.fill} />
      <polyline
        points={fcMid}
        fill="none"
        stroke={fcPalette!.stroke}
        strokeWidth="1.6"
        strokeDasharray="5 4"
      />
      {fc.touch && (
        <g className="chart-forecast-touch" aria-label="タッチライン">
          <line
            x1={x(latestEnd)}
            x2={x(fc.points.at(-1)!.timestamp)}
            y1={y(fc.touch.linePrice)}
            y2={y(fc.touch.linePrice)}
            stroke="#edc980"
            strokeWidth="1.4"
            strokeDasharray="7 4"
          />
        </g>
      )}
      {crossingMarks.map((m) => (
        <g
          key={m.key}
          className="chart-forecast-crossing"
          opacity={m.edgeOnly ? 0.65 : 1}
        >
          <line
            x1={x(latestEnd)}
            x2={m.cx}
            y1={m.cy}
            y2={m.cy}
            stroke={m.color}
            strokeDasharray="3 3"
            opacity="0.55"
          />
          <circle
            cx={m.cx}
            cy={m.cy}
            r="3.2"
            fill={m.edgeOnly ? "none" : m.color}
            stroke={m.color}
            strokeWidth="1.4"
          />
        </g>
      ))}
    </g>
  );
}

/** Keep forecast text outside the plot so nearby prices cannot overlap labels. */
export function ForecastDetails({
  fc,
  label,
  crossingMarks,
}: {
  fc: NonNullable<ChartForecast>;
  label: string | null;
  crossingMarks: CrossingMark[];
}) {
  return (
    <dl className="chart-forecast-details" aria-label="予測の詳細（模式）">
      <div>
        <dt>
          <span className="chart-detail-swatch forecast" aria-hidden="true" />
          予測（模式）
        </dt>
        <dd>{label}</dd>
      </div>
      {fc.touch && (
        <>
          <div>
            <dt>
              <span className="chart-detail-swatch touch" aria-hidden="true" />
              タッチライン
            </dt>
            <dd>
              $
              {fc.touch.linePrice >= 10
                ? fc.touch.linePrice.toFixed(2)
                : fc.touch.linePrice.toFixed(4)}
            </dd>
          </div>
          <div>
            <dt>現在値から</dt>
            <dd>
              {fc.direction === "up" ? "+" : "−"}
              {(fc.touch.distPct * 100).toFixed(2)}%
            </dd>
          </div>
          <div>
            <dt>到達確率</dt>
            <dd>{Math.round(fc.touch.prob * 100)}%</dd>
          </div>
        </>
      )}
      {crossingMarks.map((m) => (
        <div key={m.key}>
          <dt>{m.word}まで</dt>
          <dd>
            {m.edgeOnly ? "幅では" : ""}あと{m.bars}本
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function AnswerGhostOverlay({ ghost }: { ghost: AnswerGhost }) {
  return (
    <g className="chart-answer" aria-label="予測の答え合わせ">
      <line
        x1={ghost.dividerX}
        x2={ghost.dividerX}
        y1="30"
        y2="215"
        stroke="#64b5ff"
        strokeDasharray="2 4"
        opacity="0.6"
      />
      <polygon points={ghost.cone} fill={ghost.palette.fill} />
      <polyline
        points={ghost.upper}
        fill="none"
        stroke={ghost.palette.stroke}
        strokeWidth="1"
        opacity="0.45"
      />
      <polyline
        points={ghost.lower}
        fill="none"
        stroke={ghost.palette.stroke}
        strokeWidth="1"
        opacity="0.45"
      />
      <polyline
        points={ghost.mid}
        fill="none"
        stroke={ghost.palette.stroke}
        strokeWidth="1.4"
        strokeDasharray="5 4"
        opacity="0.9"
      />
      <polyline
        points={ghost.actual}
        fill="none"
        stroke="#ffffff"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </g>
  );
}

export function AnswerDetails({
  check,
  ghost,
}: {
  check: ForecastAnswerCheck;
  ghost: AnswerGhost;
}) {
  const pct = (value: number) =>
    `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
  return (
    <section className="chart-answer-details" aria-label="前の予測と実際の詳細">
      <h4>前の予測と実際</h4>
      <dl className="chart-forecast-details">
        <div>
          <dt>
            <span
              className="chart-detail-swatch"
              style={{ borderColor: ghost.palette.stroke }}
              aria-hidden="true"
            />
            当時の予測（破線）
          </dt>
          <dd>{pct(check.driftPct)}</dd>
        </div>
        <div>
          <dt>
            <span
              className="chart-detail-swatch answer-actual"
              aria-hidden="true"
            />
            実際の値動き（実線）
          </dt>
          <dd>{pct(check.actualPct)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function HoverReadout({
  hoverLines,
  chosen,
  hoverCx,
  hoverBoxW,
  hoverBoxX,
  y,
  left,
  right,
}: {
  hoverLines: { main: string; sub: string };
  chosen: Candle;
  hoverCx: number;
  hoverBoxW: number;
  hoverBoxX: number;
  y: Scale;
  left: number;
  right: number;
}) {
  return (
    <g className="chart-hover-readout" pointerEvents="none">
      <line
        x1={left}
        x2={right}
        y1={y(chosen.close)}
        y2={y(chosen.close)}
        stroke="#b0c1cf"
        strokeDasharray="2 4"
        opacity="0.35"
      />
      <circle
        cx={hoverCx}
        cy={y(chosen.close)}
        r="3"
        fill="none"
        stroke="#d7e3ea"
        strokeWidth="1.4"
      />
      <rect
        x={hoverBoxX}
        y="30"
        width={hoverBoxW}
        height="37"
        fill="rgba(4,10,16,0.87)"
        stroke="#1b2836"
      />
      <text
        x={hoverBoxX + 8}
        y="46"
        fill="#d7e3ea"
        fontSize="11.5"
        fontFamily="ui-monospace, Menlo, monospace"
      >
        {hoverLines.main}
      </text>
      <text
        x={hoverBoxX + 8}
        y="61"
        fill="#9fb8ad"
        fontSize="11.5"
        fontFamily="ui-monospace, Menlo, monospace"
      >
        {hoverLines.sub}
      </text>
    </g>
  );
}
