import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaults, type Settings } from "../packages/shared/src/index.ts";
import {
  ParameterRadar,
  parameterRadarView,
} from "../apps/dashboard/src/ParameterRadar.tsx";

const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...defaults,
  ...overrides,
});

// The production settings of 2026-11-23, as shown on the
// owner's screenshot: RSI 45, 3 candles, 4x volume, 30 s,
// 5 USDC orders, 1% daily loss cap.
const production = settings({
  oversold: 45,
  emaGapShrinkCandles: 3,
  maxVolumeChange: 4,
  intervalMs: 30_000,
  maxOrder: 5,
  dailyLossPct: 0.01,
});

describe("parameter radar view", () => {
  it("places each setting inside its schema range", () => {
    const view = parameterRadarView(production);
    const byLabel = new Map(view.axes.map((a) => [a.label, a]));
    expect(byLabel.get("RSIの買い基準")?.ratio).toBe(1);
    expect(byLabel.get("RSIの買い基準")?.valueText).toBe("45");
    expect(byLabel.get("連続本数")?.ratio).toBeCloseTo(0.125);
    expect(byLabel.get("出来高上限")?.ratio).toBeCloseTo(0.2);
    // The speed axis is inverted: the shortest interval reaches 1.
    expect(byLabel.get("確認の速さ")?.ratio).toBe(1);
    expect(byLabel.get("確認の速さ")?.valueText).toBe("30 秒");
    expect(byLabel.get("最大取引額")?.ratio).toBe(0.5);
    expect(byLabel.get("日次損失上限")?.ratio).toBe(1);
    expect(byLabel.get("日次損失上限")?.valueText).toBe("1 %");
  });

  it("names the production shape 速攻型", () => {
    const view = parameterRadarView(production);
    expect(view.type).toBe("速攻型");
    expect(view.comment).toContain("RSIの買い基準が上限いっぱい");
    expect(view.comment).toContain("連続本数は下限寄り");
  });

  it("names a defensive shape 慎重型", () => {
    const view = parameterRadarView(
      settings({
        oversold: 15,
        emaGapShrinkCandles: 9,
        maxVolumeChange: 2,
        intervalMs: 1_800_000,
        maxOrder: 1,
        dailyLossPct: 0.002,
      }),
    );
    expect(view.type).toBe("慎重型");
  });

  it("names a middle shape バランス型", () => {
    const view = parameterRadarView(
      settings({
        oversold: 27,
        emaGapShrinkCandles: 6,
        maxVolumeChange: 10,
        intervalMs: 1_830_000,
        maxOrder: 5,
        dailyLossPct: 0.005,
      }),
    );
    expect(view.type).toBe("バランス型");
  });

  it("renders the card with the type chip and axis values", () => {
    const html = renderToStaticMarkup(
      <ParameterRadar settings={production} />,
    );
    expect(html).toContain("パラメータ");
    expect(html).toContain("速攻型");
    expect(html).toContain("RSIの買い基準");
    expect(html).toContain("5 USDC");
  });
});
