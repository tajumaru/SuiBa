import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuyLineOverlay } from "../apps/dashboard/src/PriceChartOverlays.tsx";
import { IndicatorPanel } from "../apps/dashboard/src/IndicatorPanel.tsx";
import type { Candle } from "../packages/shared/src/index.ts";

describe("buy line on the price pane", () => {
  const min = 0.65,
    max = 0.69,
    y = (v: number) => 215 - ((v - min) / (max - min)) * 180;
  const render = (linePrice: number | null, currentPrice?: number | null) =>
    renderToStaticMarkup(
      <svg>
        <BuyLineOverlay
          linePrice={linePrice}
          currentPrice={currentPrice}
          min={min}
          max={max}
          y={y}
          left={40}
          right={860}
        />
      </svg>,
    );

  it("draws the dashed line and its label while the line is in range", () => {
    const html = render(0.6688);
    expect(html).toContain("chart-buy-line");
    expect(html).toContain("ライン 0.6688");
    expect(html).toContain('stroke-dasharray="7 4"');
  });

  it("draws the current price and the remaining gap to the line", () => {
    const html = render(0.6649, 0.6712);
    expect(html).toContain("chart-current-price");
    expect(html).toContain("現在 0.6712");
    expect(html).toContain("ライン 0.6649（あと −0.94%）");
  });

  it("draws the current price alone while no buy line is declared", () => {
    const html = render(null, 0.6712);
    expect(html).toContain("chart-current-price");
    expect(html).not.toContain("chart-buy-line");
  });

  it("draws nothing without a declared line", () => {
    expect(render(null)).not.toContain("chart-buy-line");
  });

  it("draws nothing while the line sits outside the visible range", () => {
    expect(render(0.72)).not.toContain("chart-buy-line");
    expect(render(0.6)).not.toContain("chart-buy-line");
  });
});

describe("buy line on the RSI pane", () => {
  const start = 1_700_000_000;
  const tf = 300;
  const candles: Candle[] = Array.from({ length: 72 }, (_, i) => ({
    timestamp: start + i * tf,
    timeframe: tf,
    open: 2,
    high: 2.1,
    low: 1.9,
    close: 2,
    volume: 10,
    source: "GeckoTerminal",
  }));
  const dataEnd = start + candles.length * tf;
  const render = (lineValue?: number | null) =>
    renderToStaticMarkup(
      <IndicatorPanel
        kind="RSI"
        candles={candles}
        sets={[candles.map(() => 50)]}
        width={375}
        start={start}
        end={dataEnd}
        dataEnd={dataEnd}
        selected={null}
        lineValue={lineValue}
        lineLabel="買いライン"
      />,
    );

  it("draws the oversold level as the buy line", () => {
    const html = render(45);
    expect(html).toContain("chart-buy-line");
    expect(html).toContain("買いライン 45");
  });

  it("adds the remaining distance from the latest RSI to the chip", () => {
    const html = renderToStaticMarkup(
      <IndicatorPanel
        kind="RSI"
        candles={candles}
        sets={[candles.map((_, i) => (i === candles.length - 1 ? 54.9 : 50))]}
        width={375}
        start={start}
        end={dataEnd}
        dataEnd={dataEnd}
        selected={null}
        lineValue={45}
        lineLabel="買いライン"
      />,
    );
    expect(html).toContain("買いライン 45（あと −9.9）");
  });

  it("draws nothing when no level is passed", () => {
    expect(render(null)).not.toContain("chart-buy-line");
    expect(render(undefined)).not.toContain("chart-buy-line");
  });
});
