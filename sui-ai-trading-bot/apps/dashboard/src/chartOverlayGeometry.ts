import type { Candle } from "../../../packages/shared/src/index.ts";
import {
  forecastLineCrossings,
  forecastPalette,
  type ChartForecast,
} from "./chartForecast.ts";
import type { ForecastAnswerCheck } from "./forecastLog.ts";

/**
 * Pure SVG geometry for the price chart's forecast overlays:
 * the outlook cone, the answer-check ghost, and the sell-line
 * crossing marks. Extracted from PriceChart.tsx so the
 * component only renders; the scale functions (x/y) and the
 * timeframe are parameters, and nothing here touches state.
 */

type Scale = (v: number) => number;

export interface ForecastGeometry {
  anchor: string | null;
  mid: string | null;
  cone: string | null;
  palette: ReturnType<typeof forecastPalette>;
  label: string;
}

export function forecastGeometry(
  fc: ChartForecast,
  latest: Candle | undefined,
  x: Scale,
  y: Scale,
  tf: number,
): ForecastGeometry {
  const anchor =
    fc && latest
      ? `${x(latest.timestamp + tf / 2)},${y(latest.close)}`
      : null;
  const mid = anchor
    ? [
        anchor,
        ...fc.points.map(
          (p) => `${x(p.timestamp + tf / 2)},${y(p.mid)}`,
        ),
      ].join(" ")
    : null;
  const cone = anchor
    ? [
        anchor,
        ...fc.points.map(
          (p) => `${x(p.timestamp + tf / 2)},${y(p.upper)}`,
        ),
        ...[...fc.points]
          .reverse()
          .map((p) => `${x(p.timestamp + tf / 2)},${y(p.lower)}`),
      ].join(" ")
    : null;
  return {
    anchor,
    mid,
    cone,
    palette: forecastPalette(fc.direction),
    label:
      fc.direction === "flat"
        ? "予測"
        : `予測 ${fc.driftPct >= 0 ? "+" : ""}${(fc.driftPct * 100).toFixed(1)}%`,
  };
}

export interface AnswerGhost {
  palette: ReturnType<typeof forecastPalette>;
  dividerX: number;
  cone: string;
  upper: string;
  lower: string;
  mid: string;
  actual: string;
  endX: number;
  midEndY: number;
  actualEndY: number;
  midAbove: boolean;
  forecastTag: string;
  actualTag: string;
}

/**
 * Answer-check geometry: the recorded cone (ghost) over the
 * bars that actually followed it, with the real closes as a
 * solid white line — dotted was the claim, solid is the fact.
 */
export function answerGhost(
  a: ForecastAnswerCheck,
  x: Scale,
  y: Scale,
  tf: number,
): AnswerGhost {
  const anchorPt = `${x(a.origin - tf / 2)},${y(a.startClose)}`,
    palette = forecastPalette(a.dir),
    pct = (f: number) => `${f >= 0 ? "+" : ""}${(f * 100).toFixed(1)}%`;
  return {
    palette,
    dividerX: x(a.origin),
    cone: [
      anchorPt,
      ...a.points.map(
        (p) => `${x(p.timestamp + tf / 2)},${y(p.upper)}`,
      ),
      ...[...a.points]
        .reverse()
        .map((p) => `${x(p.timestamp + tf / 2)},${y(p.lower)}`),
    ].join(" "),
    upper: a.points
      .map((p) => `${x(p.timestamp + tf / 2)},${y(p.upper)}`)
      .join(" "),
    lower: a.points
      .map((p) => `${x(p.timestamp + tf / 2)},${y(p.lower)}`)
      .join(" "),
    mid: [
      anchorPt,
      ...a.points.map((p) => `${x(p.timestamp + tf / 2)},${y(p.mid)}`),
    ].join(" "),
    actual: [
      anchorPt,
      ...a.actuals.map(
        (p) => `${x(p.timestamp + tf / 2)},${y(p.close)}`,
      ),
    ].join(" "),
    endX: x(a.points.at(-1)!.timestamp + tf / 2),
    midEndY: y(a.points.at(-1)!.mid),
    actualEndY: y(a.actuals.at(-1)!.close),
    midAbove: a.points.at(-1)!.mid >= a.actuals.at(-1)!.close,
    forecastTag: `予測 ${pct(a.driftPct)}`,
    actualTag: `実際 ${pct(a.actualPct)}`,
  };
}

export interface CrossingMark {
  key: "tp" | "sl";
  line: number;
  color: string;
  word: string;
  bars: number;
  cx: number;
  cy: number;
  edgeOnly: boolean;
  /** Mid hits follow the centre; edge-only hits follow the reached edge. */
  trajectory: string;
}

/**
 * Where the outlook meets the position's sell lines, if it
 * does: geometry over the sketch, labelled as such in place.
 */
export function crossingMarksFor(
  fc: ChartForecast,
  sellLines: { tp: number; sl: number },
  latest: Candle,
  x: Scale,
  y: Scale,
  tf: number,
): CrossingMark[] {
  const crossings = forecastLineCrossings(fc.points, sellLines);
  return (
    [
      {
        key: "tp",
        line: sellLines.tp,
        hit: crossings.tpMid,
        edge: crossings.tpEdge,
        color: "#43dfb2",
        word: "利確ライン",
      },
      {
        key: "sl",
        line: sellLines.sl,
        hit: crossings.slMid,
        edge: crossings.slEdge,
        color: "#f77d8f",
        word: "損切りライン",
      },
    ] as const
  ).flatMap((m) => {
    const c = m.hit ?? m.edge;
    const path = m.hit
      ? fc.points.map((p) => p.mid)
      : fc.points.map((p) => (m.key === "tp" ? p.upper : p.lower));
    return c
      ? [
          {
            key: m.key,
            line: m.line,
            color: m.color,
            word: m.word,
            bars: c.bars,
            cx: x(c.timestamp + tf / 2),
            cy: y(m.line),
            edgeOnly: !m.hit,
            trajectory: [
              // Purpose-built only to the sell-line crossing: do not restore
              // the centre line across the cone or draw beyond the target.
              `${x(latest.timestamp + tf / 2)},${y(latest.close)}`,
              ...path.slice(0, c.bars).map((value, i) =>
                `${x(fc.points[i].timestamp + tf / 2)},${
                  i === c.bars - 1 ? y(m.line) : y(value)
                }`,
              ),
            ].join(" "),
          },
        ]
      : [];
  });
}
