import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  PriceChart,
  candleHoverLines,
} from "../apps/dashboard/src/PriceChart.tsx";
import type { Candle } from "../packages/shared/src/index.ts";
import {
  HoverReadout,
  HoverMarker,
} from "../apps/dashboard/src/PriceChartOverlays.tsx";

function candle(partial: Partial<Candle>): Candle {
  return {
    timestamp: Date.UTC(2026, 10, 3, 6, 35) / 1000,
    timeframe: 300,
    open: 0.87,
    high: 0.885,
    low: 0.865,
    close: 0.8799,
    volume: 10,
    source: "GeckoTerminal",
    ...partial,
  };
}

describe("candleHoverLines", () => {
  it("leads with the JST start time, the close and the signed move", () => {
    const { main, sub } = candleHoverLines(candle({}));
    // 06:35 UTC is 15:35 in Tokyo.
    expect(main.startsWith("11/3 15:35")).toBe(true);
    expect(main).toContain("終 0.8799");
    expect(main).toContain("(+1.14%)");
    expect(sub).toContain("始 0.87");
    expect(sub).toContain("高 0.885");
    expect(sub).toContain("安 0.865");
  });
  it("signs a down candle without a plus", () => {
    const { main } = candleHoverLines(candle({ open: 0.88, close: 0.8712 }));
    expect(main).toContain("(-1%)");
  });
});

describe("PriceChart hover readout", () => {
  it("renders no readout until a candle is selected", () => {
    const now = Math.floor(Date.now() / 1000 / 300) * 300;
    const cs = Array.from({ length: 30 }, (_, i) =>
      candle({
        timestamp: now - (29 - i) * 300,
        open: 0.87,
        close: 0.87 + i * 0.0004,
        high: 0.885,
        low: 0.864,
      }),
    );
    const html = renderToStaticMarkup(
      React.createElement(PriceChart, { candles: cs, trades: [] }),
    );
    expect(html).toContain("interactive-price-chart");
    expect(html).not.toContain("chart-hover-readout");
    expect(html).toContain('data-empty="true"');
    expect(html.indexOf('class="chart-selected-readout"')).toBeLessThan(
      html.indexOf("<svg"),
    );
  });

  it("keeps the existing date, OHLC and percentage text in the HTML readout", () => {
    const html = renderToStaticMarkup(
      React.createElement(HoverReadout, {
        hoverLines: candleHoverLines(candle({})),
      }),
    );
    expect(html).toContain('aria-label="選択した足の情報"');
    expect(html).toContain("11/3 15:35 終 0.8799 (+1.14%)");
    expect(html).toContain("始 0.87 高 0.885 安 0.865");
    expect(html).not.toContain("<svg");
  });

  it("keeps the selected-price marker without a box or text in the plot", () => {
    const html = renderToStaticMarkup(
      React.createElement(
        "svg",
        null,
        React.createElement(HoverMarker, {
          chosen: candle({}),
          hoverCx: 80,
          y: (v) => v * 100,
          left: 22,
          right: 300,
        }),
      ),
    );
    expect(html).toContain("<line");
    expect(html).toContain("<circle");
    expect(html).not.toContain("<rect");
    expect(html).not.toContain("<text");
  });
});
