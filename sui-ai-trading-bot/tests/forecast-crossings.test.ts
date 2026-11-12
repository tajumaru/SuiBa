import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  chartForecast,
  forecastLineCrossings,
  type ForecastPoint,
} from "../apps/dashboard/src/chartForecast.ts";
import { PriceChart } from "../apps/dashboard/src/PriceChart.tsx";
import type { Candle } from "../packages/shared/src/index.ts";

const T0 = 1_700_000_000;
function points(mids: number[], halfWidth = 0.002): ForecastPoint[] {
  return mids.map((mid, i) => ({
    timestamp: T0 + i * 300,
    mid,
    upper: mid + halfWidth,
    lower: mid - halfWidth,
  }));
}

describe("forecastLineCrossings", () => {
  it("finds the first bar where the centre path reaches each line", () => {
    const pts = points([1.0, 1.004, 1.009, 1.015, 1.02]);
    const r = forecastLineCrossings(pts, { tp: 1.01, sl: 0.99 });
    expect(r.tpMid?.bars).toBe(4);
    expect(r.tpMid?.timestamp).toBe(T0 + 3 * 300);
    expect(r.tpEdge).toBeNull();
    expect(r.slMid).toBeNull();
    expect(r.slEdge).toBeNull();
  });
  it("reports an edge-only reach when the centre stays short", () => {
    const pts = points([1.0, 1.002, 1.003], 0.004);
    const r = forecastLineCrossings(pts, { tp: 1.0055, sl: 0.9 });
    expect(r.tpMid).toBeNull();
    expect(r.tpEdge?.bars).toBe(2);
  });
  it("mirrors for the stop-loss side on a falling path", () => {
    const pts = points([1.0, 0.996, 0.99, 0.985]);
    const r = forecastLineCrossings(pts, { tp: 1.05, sl: 0.992 });
    expect(r.slMid?.bars).toBe(3);
    expect(r.slEdge).toBeNull();
    expect(r.tpMid).toBeNull();
    expect(r.tpEdge).toBeNull();
  });
  it("returns nothing when the outlook reaches neither line", () => {
    const r = forecastLineCrossings(points([1.0, 1.001]), {
      tp: 1.5,
      sl: 0.5,
    });
    expect(r).toEqual({
      tpMid: null,
      tpEdge: null,
      slMid: null,
      slEdge: null,
    });
  });
});

describe("PriceChart forecast crossing marks", () => {
  it("labels the bar where the outlook reaches the take-profit line", () => {
    const now = Math.floor(Date.now() / 1000 / 300) * 300;
    const cs: Candle[] = Array.from({ length: 60 }, (_, i) => {
      const close = 2 + i * 0.012;
      return {
        timestamp: now - (59 - i) * 300,
        timeframe: 300,
        open: close,
        high: close + 0.005,
        low: close - 0.005,
        close,
        volume: 10,
        source: "GeckoTerminal",
      };
    });
    const fc = chartForecast(cs, 24, null);
    expect(fc).not.toBeNull();
    // A take-profit line the centre path is guaranteed to cross
    // partway through the horizon.
    const tp = fc!.points[8].mid;
    const html = renderToStaticMarkup(
      React.createElement(PriceChart, {
        candles: cs,
        trades: [],
        sellLines: { tp, sl: 0.5 },
      }),
    );
    expect(html).toContain("chart-forecast-crossing");
    expect(html).toContain("利確ライン");
    expect(html).not.toContain("損切りライン");
    const plot = html.slice(html.indexOf("<svg"), html.indexOf("</svg>"));
    expect(plot).toContain("chart-forecast-crossing");
    expect(plot).not.toContain("利確ライン");
    expect(plot).not.toContain("タッチライン $");
    const details = html.slice(html.indexOf('class="chart-forecast-details"'));
    expect(details).toContain("予測の詳細（模式）");
    expect(details).toContain("利確ラインまで");
    expect(details).toContain("あと");
    if (fc!.touch) {
      expect(details).toContain("タッチライン");
      expect(details).toContain("到達確率");
      expect(details).toContain(`${Math.round(fc!.touch.prob * 100)}%`);
    }
  });
});
