import type { Candle } from "../../../packages/shared/src/index.ts";
import type { ChartForecast } from "./chartForecast.ts";
import { forecastPalette } from "./chartForecast.ts";
import type { ForecastAnswerCheck } from "./forecastLog.ts";
import type { AnswerGhost, CrossingMark } from "./chartOverlayGeometry.ts";
import { number } from "./presentation.ts";
import { chartTime } from "./chartPresentation.ts";

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
  fcPalette,
  crossingMarks,
  x,
  y,
  latestEnd,
}: {
  fc: ChartForecast;
  fcCone: string;
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
          <polyline
            points={m.trajectory}
            fill="none"
            stroke={m.color}
            strokeDasharray="3 3"
            strokeWidth={m.edgeOnly ? "1" : "1.5"}
            strokeLinejoin="round"
            opacity={m.edgeOnly ? "0.45" : "0.75"}
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

/** Whether the recent closes are actually moving toward the
 * line: the latest close sits closer to it than the first of the
 * last few closes did. This gates the buy-run line's staging
 * (owner, 2026-11-26): a constant "あと −X%" countdown while the
 * price walks away reads as "about to buy" for hours and teaches
 * the reader to ignore the chip, so the full staging is earned
 * only while the price approaches the line (or has reached it).
 * The line itself is only declared when every other buy
 * condition already holds, so approach is the honest last gate. */
export function isLineApproaching(
  closes: readonly number[],
  linePrice: number,
): boolean {
  if (!Number.isFinite(linePrice) || linePrice <= 0) return false;
  const recent = closes
    .filter((v) => Number.isFinite(v) && v > 0)
    .slice(-4);
  if (recent.length < 2) return false;
  const first = recent[0];
  const last = recent[recent.length - 1];
  return Math.abs(last - linePrice) < Math.abs(first - linePrice);
}

/** The buy-run line on the price pane: the next close at which
 * RSI would reach its line — the same value the ticker pill
 * counts down to — drawn only while it sits inside the visible
 * price range, so the chart itself shows where the buy run
 * starts. The current price itself is drawn as a solid line
 * with its own chip, so the gap between the two can be read off
 * the chart. Staging (owner, 2026-11-26): while `hot` — the
 * price approaching the line, or at/under it — the chip wears
 * the pill's colours and carries the remaining distance.
 * Otherwise the line and chip stay quiet (thin, muted, price
 * only): a landmark, not a countdown. */
export function BuyLineOverlay({
  linePrice,
  hot = false,
  currentPrice,
  min,
  max,
  y,
  left,
  right,
}: {
  linePrice: number | null;
  hot?: boolean;
  currentPrice?: number | null;
  min: number;
  max: number;
  y: Scale;
  left: number;
  right: number;
}) {
  const inRange = (v: number | null | undefined): v is number =>
    v != null && Number.isFinite(v) && v > 0 && v >= min && v <= max;
  const showLine = inRange(linePrice);
  const showCurrent = inRange(currentPrice);
  if (!showLine && !showCurrent) return null;
  const fmt = (v: number) => (v >= 10 ? v.toFixed(2) : v.toFixed(4));
  const chipW = (text: string) =>
    [...text].reduce(
      (sum, ch) => sum + (ch.charCodeAt(0) > 0x2000 ? 11 : 6.4),
      0,
    ) + 16;
  const chipH = 18;
  const clampChipY = (cy: number) =>
    Math.min(215 - chipH, Math.max(30, cy - chipH / 2));
  const gap =
    showLine &&
    currentPrice != null &&
    Number.isFinite(currentPrice) &&
    currentPrice > 0
      ? (linePrice / currentPrice - 1) * 100
      : null;
  const lineText = showLine
    ? hot && gap != null
      ? `ライン ${fmt(linePrice)}（あと ${gap >= 0 ? "+" : "−"}${Math.abs(gap).toFixed(2)}%）`
      : `ライン ${fmt(linePrice)}`
    : "";
  const lineY = showLine ? y(linePrice) : 0;
  const lineChipY = showLine ? clampChipY(lineY) : 0;
  const curText = showCurrent ? `現在 ${fmt(currentPrice)}` : "";
  const curY = showCurrent ? y(currentPrice) : 0;
  let curChipY = showCurrent ? clampChipY(curY) : 0;
  if (showLine && showCurrent && Math.abs(curChipY - lineChipY) < 20)
    curChipY = Math.min(
      215 - chipH,
      Math.max(30, lineChipY + (curY >= lineY ? 20 : -20)),
    );
  return (
    <g>
      {showCurrent && (
        <g className="chart-current-price" aria-label="現在価格">
          <line
            x1={left}
            x2={right}
            y1={curY}
            y2={curY}
            stroke="#e6eef2"
            strokeWidth="1.2"
            opacity="0.85"
          />
          <rect
            x={right - chipW(curText)}
            y={curChipY}
            width={chipW(curText)}
            height={chipH}
            rx="4"
            fill="#22303a"
            stroke="#b0c1cf"
            strokeOpacity="0.7"
          />
          <text
            x={right - chipW(curText) / 2}
            y={curChipY + 13}
            fill="#e6eef2"
            fontSize="11"
            fontWeight="700"
            textAnchor="middle"
          >
            {curText}
          </text>
        </g>
      )}
      {showLine && (
        <g className="chart-buy-line" aria-label="買い走りライン">
          <line
            x1={left}
            x2={right}
            y1={lineY}
            y2={lineY}
            stroke={hot ? "#64b5ff" : "#54708c"}
            strokeWidth={hot ? "1.4" : "1"}
            strokeDasharray="7 4"
            opacity={hot ? undefined : "0.55"}
          />
          <rect
            x={right - chipW(lineText)}
            y={lineChipY}
            width={chipW(lineText)}
            height={chipH}
            rx="4"
            fill={hot ? "#10325c" : "#1b2836"}
            stroke={hot ? "#62b2ff" : "#54708c"}
            strokeOpacity="0.6"
          />
          <text
            x={right - chipW(lineText) / 2}
            y={lineChipY + 13}
            fill={hot ? "#bfe0ff" : "#9db4c6"}
            fontSize="11"
            fontWeight={hot ? "700" : "400"}
            textAnchor="middle"
          >
            {lineText}
          </text>
        </g>
      )}
    </g>
  );
}

/** Keep forecast text outside the plot so nearby prices cannot overlap labels. */
export function ForecastDetails({
  fc,
  horizonHours,
  label,
  crossingMarks,
}: {
  fc: NonNullable<ChartForecast>;
  horizonHours: number;
  label: string | null;
  crossingMarks: CrossingMark[];
}) {
  return (
    <dl className="chart-forecast-details" aria-label="予測の詳細（模式）">
      <div>
        <dt>
          <span
            className="chart-detail-swatch forecast"
            style={{ backgroundColor: forecastPalette(fc.direction).fill }}
            aria-hidden="true"
          />
          これから{number(horizonHours, 1)}時間の予測範囲（帯）
        </dt>
        <dd>{label}（模式）</dd>
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
  timeframe,
}: {
  check: ForecastAnswerCheck;
  ghost: AnswerGhost;
  timeframe: number;
}) {
  const start = chartTime(check.origin);
  const end = chartTime(check.actuals.at(-1)!.timestamp + timeframe);
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  const pct = (value: number) =>
    `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
  return (
    <section className="chart-answer-details" aria-label="前の予測と実際の詳細">
      <h4>前の予測と実際</h4>
      <p className="chart-meta">
        比較期間：{start}〜{sameDay ? end.slice(11) : end}（日本時間）
      </p>
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
}: {
  hoverLines: { main: string; sub: string } | null;
}) {
  return (
    <div
      className="chart-selected-readout"
      role="group"
      aria-label="選択した足の情報"
      data-empty={hoverLines == null}
    >
      {hoverLines && (
        <>
          <p>{hoverLines.main}</p>
          <p>{hoverLines.sub}</p>
        </>
      )}
    </div>
  );
}

export function HoverMarker({
  chosen,
  hoverCx,
  y,
  left,
  right,
}: {
  chosen: Candle;
  hoverCx: number;
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
    </g>
  );
}
