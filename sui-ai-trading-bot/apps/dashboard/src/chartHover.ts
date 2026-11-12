import type { Candle } from "../../../packages/shared/src/index.ts";
import { number } from "./presentation.ts";

const hoverTimeFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
/**
 * The two readout lines shown above the chart while a candle
 * is hovered or tapped: when it started and where it closed
 * (with the move across the candle), then the rest of the
 * OHLC. The full record (volume, source, provenance) stays in
 * the detail panel below; this is the at-a-glance version.
 */
export function candleHoverLines(b: Candle): {
  main: string;
  sub: string;
} {
  const pct =
    b.open > 0 ? ((b.close - b.open) / b.open) * 100 : 0;
  return {
    main: `${hoverTimeFormat.format(b.timestamp * 1000)} 終 ${number(b.close, 4)} (${pct >= 0 ? "+" : ""}${number(pct, 2)}%)`,
    sub: `始 ${number(b.open, 4)} 高 ${number(b.high, 4)} 安 ${number(b.low, 4)}`,
  };
}
/** Rough rendered width of a readout line (full-width glyphs
 * count double) so the backdrop box can hug the text. */
export function hoverLineWidth(line: string): number {
  let w = 0;
  for (const ch of line) w += ch.charCodeAt(0) > 0x2000 ? 11.5 : 6.9;
  return w;
}
