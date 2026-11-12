import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IndicatorPanel } from "../apps/dashboard/src/IndicatorPanel.tsx";
import type { Candle } from "../packages/shared/src/index.ts";

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
const warning = "データ不足：表示期間に欠損があります。";

describe.each(["RSI", "MACD"] as const)("%s historical gap warning", (kind) => {
  const render = (cs: Candle[], futureBars: number) =>
    renderToStaticMarkup(
      <IndicatorPanel
        kind={kind}
        candles={cs}
        sets={[cs.map(() => 50)]}
        width={375}
        start={start}
        end={dataEnd + futureBars * tf}
        dataEnd={dataEnd}
        selected={null}
      />,
    );

  it("keeps forecast space without reporting missing historical data", () => {
    const html = render(candles, 24);
    expect(html).not.toContain(warning);
    expect(html).toContain(`aria-label="${kind}チャート"`);
    expect(html).toContain("<polyline");
  });

  it.each([0, 35, 71])(
    "still warns about an actual missing candle at index %i",
    (index) => {
      const cs = candles.filter((_, i) => i !== index);
      expect(render(cs, 24)).toContain(warning);
      expect(render(cs, 0)).toContain(warning);
    },
  );

  it("does not warn for complete history without a forecast", () => {
    expect(render(candles, 0)).not.toContain(warning);
  });
});
