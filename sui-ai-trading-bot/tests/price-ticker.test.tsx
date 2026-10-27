import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import {
  PriceTicker,
  changeTone,
  formatChangePct,
  formatTickerPrice,
  sparklinePoints,
  tickerChange,
} from "../apps/dashboard/src/PriceTicker.tsx";

type State = ReturnType<BotEngine["snapshot"]>;
type Frames = State["candlesByTimeframe"];
type Candle = Frames[300][number];

const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");
const css = readFileSync(
  resolve("apps/dashboard/src/style.css"),
  "utf8",
).replace(/\r\n/g, "\n");

const T0 = 1_700_000_000;

function candle(timestamp: number, close: number, timeframe = 3600): Candle {
  return {
    timestamp,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    source: "test",
    timeframe,
  } as Candle;
}

function frames(partial: Partial<Record<300 | 900 | 3600, Candle[]>>): Frames {
  return { 300: [], 900: [], 3600: [], ...partial } as Frames;
}

/** Hourly candles from T0, `count` of them, close rising linearly. */
function hourly(count: number, from: number, to: number): Candle[] {
  return Array.from({ length: count }, (_, i) =>
    candle(T0 + i * 3600, from + ((to - from) * i) / (count - 1)),
  );
}

describe("ticker price formatting", () => {
  it("keeps four decimals for sub-dollar prices", () => {
    expect(formatTickerPrice(0.9234)).toBe("$0.9234");
    expect(formatTickerPrice(0.92346)).toBe("$0.9235");
  });

  it("trims trailing zeros but never below two decimals", () => {
    expect(formatTickerPrice(0.92)).toBe("$0.92");
    expect(formatTickerPrice(12.3)).toBe("$12.30");
    expect(formatTickerPrice(5)).toBe("$5.00");
  });

  it("groups thousands with two decimals", () => {
    expect(formatTickerPrice(1234.5)).toBe("$1,234.50");
  });

  it("fails closed to an em dash for missing or invalid prices", () => {
    expect(formatTickerPrice(null)).toBe("—");
    expect(formatTickerPrice(undefined)).toBe("—");
    expect(formatTickerPrice(0)).toBe("—");
    expect(formatTickerPrice(-1)).toBe("—");
    expect(formatTickerPrice(Number.NaN)).toBe("—");
    expect(formatTickerPrice(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("ticker change formatting", () => {
  it("always signs non-zero changes and colours them by direction", () => {
    expect(formatChangePct(0.0153)).toBe("+1.53%");
    expect(changeTone(0.0153)).toBe("up");
    expect(formatChangePct(-0.0153)).toBe("-1.53%");
    expect(changeTone(-0.0153)).toBe("down");
  });

  it("renders an exact zero change unsigned and neutral", () => {
    expect(formatChangePct(0)).toBe("0.00%");
    expect(changeTone(0)).toBe("flat");
  });
});

describe("ticker change derivation", () => {
  it("computes a true 24h change when the hourly frame reaches back a day", () => {
    const change = tickerChange(frames({ 3600: hourly(25, 1.0, 1.1) }));
    expect(change).not.toBeNull();
    expect(change!.label).toBe("24時間");
    expect(change!.pct).toBeCloseTo(0.1, 10);
    // The sparkline window is the same 24 hours: ref candle to last.
    expect(change!.closes).toHaveLength(25);
    expect(change!.closes[0]).toBeCloseTo(1.0);
    expect(change!.closes.at(-1)).toBeCloseTo(1.1);
  });

  it("uses a finer frame for the 24h change when the hourly frame is absent", () => {
    const fifteenMin = Array.from({ length: 97 }, (_, i) =>
      candle(T0 + i * 900, 2.0 + i * 0.001, 900),
    );
    const change = tickerChange(frames({ 900: fifteenMin }));
    expect(change!.label).toBe("24時間");
    expect(change!.pct).toBeCloseTo(2.096 / 2.0 - 1, 10);
  });

  it("does not stretch a gappy series into a 24h claim", () => {
    // Only two hourly candles, ~27.8h apart: the candle before the
    // 24h mark sits more than one frame away from it, so the change
    // falls back to the recorded span and names it.
    const gappy = [candle(T0, 1.0), candle(T0 + 100_000, 1.05)];
    const change = tickerChange(frames({ 3600: gappy }));
    expect(change!.label).toBe("28時間");
    expect(change!.pct).toBeCloseTo(0.05, 10);
  });

  it("falls back to the longest recorded span and labels it honestly", () => {
    const fiveMin = Array.from({ length: 7 }, (_, i) =>
      candle(T0 + i * 300, 1.0 + i * 0.01, 300),
    );
    const change = tickerChange(frames({ 300: fiveMin }));
    expect(change!.label).toBe("30分");
    expect(change!.pct).toBeCloseTo(0.06, 10);
  });

  it("prefers the longest span across frames for the fallback", () => {
    const short = Array.from({ length: 13 }, (_, i) =>
      candle(T0 + i * 300, 1.0, 300),
    );
    const longer = Array.from({ length: 13 }, (_, i) =>
      candle(T0 + i * 900, 1.0 + i * 0.01, 900),
    );
    const change = tickerChange(frames({ 300: short, 900: longer }));
    expect(change!.label).toBe("3時間");
  });

  it("fails closed when no frame can ground a change", () => {
    expect(tickerChange(frames({}))).toBeNull();
    expect(tickerChange(frames({ 3600: hourly(1, 1.0, 1.0) }))).toBeNull();
    // Candles with unusable closes are dropped before counting.
    const bad = [candle(T0, 0), candle(T0 + 3600, Number.NaN)];
    expect(tickerChange(frames({ 3600: bad }))).toBeNull();
  });
});

describe("sparkline points", () => {
  it("normalises values into the viewBox, rising to the top", () => {
    expect(sparklinePoints([1, 2, 3])).toBe("0,22 40,12 80,2");
  });

  it("draws a flat series on the midline", () => {
    expect(sparklinePoints([5, 5, 5])).toBe("0,12 40,12 80,12");
  });

  it("downsamples to the point cap, keeping both ends", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const points = sparklinePoints(values)!.split(" ");
    expect(points).toHaveLength(40);
    expect(points[0].startsWith("0,")).toBe(true);
    expect(points.at(-1)!.startsWith("80,")).toBe(true);
  });

  it("fails closed below two finite values", () => {
    expect(sparklinePoints([])).toBeNull();
    expect(sparklinePoints([1])).toBeNull();
    expect(sparklinePoints([Number.NaN, 1])).toBeNull();
    expect(sparklinePoints([1, Number.NaN, 3])).toBe("0,22 80,2");
  });
});

describe("price ticker rendering", () => {
  it("shows price, signed change with its window, and the sparkline", () => {
    const html = renderToStaticMarkup(
      <PriceTicker price={1.1} candlesByTimeframe={frames({ 3600: hourly(25, 1.0, 1.1) })} />,
    );
    expect(html).toContain('class="price-ticker"');
    expect(html).toContain('fill="#4da2ff"');
    expect(html).toContain("SUI/USDC");
    expect(html).toContain("$1.10");
    expect(html).toContain('class="price-ticker-change up"');
    expect(html).toContain("+10.00%");
    expect(html).toContain("24時間");
    expect(html).toContain("<polyline");
    expect(html).toContain('stroke="#43dfb2"');
    expect(html).toContain(
      'aria-label="SUI/USDC 現在価格 $1.10、24時間で+10.00%"',
    );
  });

  it("colours a falling change and its sparkline red", () => {
    const html = renderToStaticMarkup(
      <PriceTicker price={0.9} candlesByTimeframe={frames({ 3600: hourly(25, 1.0, 0.9) })} />,
    );
    expect(html).toContain('class="price-ticker-change down"');
    expect(html).toContain("-10.00%");
    expect(html).toContain('stroke="#ff6b81"');
  });

  it("shows the price alone when no candle frame is loaded yet", () => {
    const html = renderToStaticMarkup(
      <PriceTicker price={0.9234} candlesByTimeframe={frames({})} />,
    );
    expect(html).toContain("$0.9234");
    expect(html).not.toContain("price-ticker-change");
    expect(html).not.toContain("<polyline");
    expect(html).toContain('aria-label="SUI/USDC 現在価格 $0.9234"');
  });

  it("shows an em dash when the snapshot has no price yet", () => {
    const html = renderToStaticMarkup(
      <PriceTicker price={null} candlesByTimeframe={frames({})} />,
    );
    expect(html).toContain("—");
    expect(html).toContain('aria-label="SUI/USDC 現在価格 —"');
  });

  it("counts down to the buy-run line and flips at the touch", () => {
    const down = renderToStaticMarkup(
      <PriceTicker
        price={0.9018}
        candlesByTimeframe={frames({})}
        linePrice={0.874}
      />,
    );
    expect(down).toContain('class="price-ticker-line"');
    expect(down).toContain('price-ticker-line-prefix">買い走り');
    expect(down).toContain("ライン $0.874 あと-3.1%");
    expect(down).toContain("買い走りライン $0.874 まであと-3.1%");
    const reached = renderToStaticMarkup(
      <PriceTicker
        price={0.8731}
        candlesByTimeframe={frames({})}
        linePrice={0.874}
      />,
    );
    expect(reached).toContain('class="price-ticker-line reached"');
    expect(reached).toContain("ライン到達・反発待ち");
    const none = renderToStaticMarkup(
      <PriceTicker price={0.9018} candlesByTimeframe={frames({})} />,
    );
    expect(none).not.toContain("price-ticker-line");
  });
});

describe("price ticker wiring and style", () => {
  it("rides directly under the operation bar, inside the snapshot block", () => {
    const barAt = main.indexOf("<OperationBar");
    const tickerAt = main.indexOf("<PriceTicker");
    const snapshotBlockAt = main.indexOf("{data && (");
    expect(barAt).toBeGreaterThan(-1);
    expect(tickerAt).toBeGreaterThan(barAt);
    expect(snapshotBlockAt).toBeGreaterThan(-1);
    expect(snapshotBlockAt).toBeLessThan(barAt);
    // Before every tab panel: the ticker is tab-independent.
    expect(tickerAt).toBeLessThan(main.indexOf('activeTab === "Overview"'));
    expect(main).toContain("price={data.price}");
    expect(main).toContain("candlesByTimeframe={data.candlesByTimeframe}");
  });

  it("is styled like the operation bar, one line, sparkline shrinks first", () => {
    expect(css).toContain(".price-ticker {");
    expect(css).toContain("background: #0e1626;");
    expect(css).toContain("border-radius: 10px;");
    const spark = css.slice(css.indexOf(".price-ticker-spark {"));
    expect(spark.slice(0, spark.indexOf("}"))).toContain("flex: 0 1 80px;");
  });
});
