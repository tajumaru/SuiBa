import type { Candle } from "../../../packages/shared/src/index.ts";
// Batch SVG commands without sampling, rounding, or changing a candle's OHLC.
export function candleGeometry(
  candles: Candle[],
  x: (t: number) => number,
  y: (price: number) => number,
  width: number,
) {
  const groups = new Map<
    string,
    { color: string; style: string; wick: string[]; body: string[] }
  >();
  const markers: { x: number; symbol: string }[] = [];
  for (const b of candles) {
    const color = b.close >= b.open ? "#43dfb2" : "#f77d8f",
      style =
        (b.timestamp + b.timeframe) * 1000 > Date.now()
          ? "provisional"
          : b.provenance && b.provenance.origin !== "ORIGINAL"
            ? "reconstructed"
            : "original",
      key = color + style;
    let group = groups.get(key);
    if (!group) {
      group = { color, style, wick: [], body: [] };
      groups.set(key, group);
    }
    const middle = x(b.timestamp + b.timeframe / 2),
      top = y(Math.max(b.open, b.close)),
      height = Math.max(1, Math.abs(y(b.open) - y(b.close)));
    group.wick.push(`M ${middle} ${y(b.high)} V ${y(b.low)}`);
    group.body.push(
      `M ${middle - width / 2} ${top} h ${width} v ${height} h ${-width} Z`,
    );
    if (style !== "original")
      markers.push({ x: middle, symbol: style === "provisional" ? "○" : "◇" });
  }
  return {
    groups: [...groups.values()].map((g) => ({
      ...g,
      wick: g.wick.join(" "),
      body: g.body.join(" "),
    })),
    markers,
  };
}
