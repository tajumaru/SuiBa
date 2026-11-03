import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  PriceChart,
  candleHoverLines,
} from "../apps/dashboard/src/PriceChart.tsx";
import type { Candle } from "../packages/shared/src/index.ts";

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
    const { main } = candleHoverLines(
      candle({ open: 0.88, close: 0.8712 }),
    );
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
  });
});
