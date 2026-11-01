import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Candle } from "../packages/shared/src/index.ts";
import {
  chartForecast,
  CONE_LOWER_SHAPE,
  CONE_UPPER_SHAPE,
  FORECAST_BARS,
} from "../apps/dashboard/src/chartForecast.ts";
import { PriceChart } from "../apps/dashboard/src/PriceChart.tsx";

const T0 = Date.UTC(2026, 10, 1, 0) / 1000;
function candles(
  closes: number[],
  range = 0.01,
): Candle[] {
  return closes.map((close, i) => ({
    timestamp: T0 + i * 300,
    timeframe: 300,
    open: close,
    high: close + range / 2,
    low: close - range / 2,
    close,
    volume: 10,
    source: "GeckoTerminal",
  }));
}
// A strong staircase: the RSI brake fades drift at extremes by
// design, so a direction word needs a genuinely strong trend.
const rising = candles(Array.from({ length: 60 }, (_, i) => 2 + i * 0.012));
const falling = candles(Array.from({ length: 60 }, (_, i) => 3 - i * 0.012));
const flat = candles(
  Array.from({ length: 60 }, (_, i) => 2 + (i % 2 ? 0.002 : -0.002)),
  0.02,
);

describe("chartForecast", () => {
  it("projects 24 widening points along a rising trend", () => {
    const fc = chartForecast(rising)!;
    expect(fc).not.toBeNull();
    expect(fc.points).toHaveLength(FORECAST_BARS);
    expect(fc.direction).toBe("up");
    expect(fc.directionWord).toBe("上向き気味");
    const last = rising.at(-1)!;
    expect(fc.points[0].timestamp).toBe(last.timestamp + 300);
    expect(fc.points.at(-1)!.timestamp).toBe(last.timestamp + 24 * 300);
    expect(fc.points.at(-1)!.mid).toBeGreaterThan(last.close);
    for (const p of fc.points) {
      expect(p.upper).toBeGreaterThan(p.mid);
      expect(p.mid).toBeGreaterThan(p.lower);
    }
    const firstHalf = fc.points[0].upper - fc.points[0].mid,
      lastHalf = fc.points.at(-1)!.upper - fc.points.at(-1)!.mid;
    expect(lastHalf).toBeGreaterThan(firstHalf);
    expect(fc.bandPct).toBeGreaterThan(0);
  });

  it("projects a falling trend downward", () => {
    const fc = chartForecast(falling)!;
    expect(fc.direction).toBe("down");
    expect(fc.points.at(-1)!.mid).toBeLessThan(falling.at(-1)!.close);
  });

  it("calls a directionless market flat", () => {
    const fc = chartForecast(flat)!;
    expect(fc.direction).toBe("flat");
    expect(fc.directionWord).toBe("横ばい気味");
  });

  it("uses the measured asymmetric cone shape", () => {
    expect(CONE_UPPER_SHAPE).toHaveLength(FORECAST_BARS);
    expect(CONE_LOWER_SHAPE).toHaveLength(FORECAST_BARS);
    for (const shape of [CONE_UPPER_SHAPE, CONE_LOWER_SHAPE]) {
      expect(shape[0]).toBeGreaterThan(0);
      for (let i = 1; i < shape.length; i++)
        expect(shape[i]).toBeGreaterThanOrEqual(shape[i - 1]);
    }
    // In the measured sample, downside excursions ran wider.
    const fc = chartForecast(rising)!;
    const lastPoint = fc.points.at(-1)!;
    expect(lastPoint.mid - lastPoint.lower).toBeGreaterThan(
      lastPoint.upper - lastPoint.mid,
    );
  });

  it("fails closed on short, gapped or motionless input", () => {
    expect(chartForecast(rising.slice(0, 20))).toBeNull();
    const gapped = [...rising];
    gapped[55] = { ...gapped[55], timestamp: gapped[55].timestamp + 300 };
    // The gap leaves a trailing run of 4 — too short to trust.
    expect(chartForecast(gapped)).toBeNull();
    const still = candles(Array.from({ length: 60 }, () => 2), 0);
    expect(chartForecast(still)).toBeNull();
    expect(chartForecast([])).toBeNull();
  });
});

describe("PriceChart forecast overlay", () => {
  const render = (cs: Candle[]) =>
    renderToStaticMarkup(
      React.createElement(PriceChart, { candles: cs, trades: [] }),
    );

  it("draws the cone and the model caption in the latest view", () => {
    const html = render(rising);
    expect(html).toContain("chart-forecast");
    expect(html).toContain("予測（模式）");
    expect(html).toContain("上向き気味");
    expect(html).toContain("実際の価格ではありません");
  });

  it("omits the forecast when the data cannot carry one", () => {
    const html = render(rising.slice(0, 10));
    expect(html).not.toContain("chart-forecast");
    expect(html).not.toContain("予測（模式）");
  });

  it("shows the score line only with a forecast and score text", () => {
    const withScore = renderToStaticMarkup(
      React.createElement(PriceChart, {
        candles: rising,
        trades: [],
        forecastScoreText: "予測の成績：コーン収まり 82%（判定 46 件）",
      }),
    );
    expect(withScore).toContain("chart-forecast-score");
    expect(withScore).toContain("コーン収まり 82%");
    expect(render(rising)).not.toContain("chart-forecast-score");
  });
});
