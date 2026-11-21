import { describe, expect, it } from "vitest";
import type { DecisionTelemetry } from "../apps/worker/src/operations.ts";
import type { EntryConditionChip } from "../apps/dashboard/src/narration/state.ts";
import { chipDetailLine } from "../apps/dashboard/src/narration/watch.ts";

const dec = {
  price: 0.6171,
  ema20: 0.6179,
  ema50: 0.6162,
  rsi: 58.2,
  oversold: 45,
  histogram: -0.0012,
  previousHistogram: -0.0015,
} as unknown as DecisionTelemetry;

const chip = (over: Partial<EntryConditionChip>): EntryConditionChip => ({
  key: "ema",
  label: "EMA",
  met: false,
  status: "",
  tone: "far",
  watching: false,
  ...over,
});

describe("chipDetailLine", () => {
  it("EMA met shows the signed gap", () => {
    expect(chipDetailLine(chip({ key: "ema", met: true }), dec)).toBe(
      "EMA 成立：差 +0.2755%",
    );
  });
  it("EMA unmet carries the status word", () => {
    expect(
      chipDetailLine(chip({ key: "ema", status: "逆並び" }), dec),
    ).toContain("EMA 逆並び：差");
  });
  it("RSI far shows the current value and the distance to the line", () => {
    expect(
      chipDetailLine(
        chip({ key: "rsi", label: "RSI", status: "あと13", detail: "あと13" }),
        dec,
      ),
    ).toBe("RSI：今 58.2、ラインまで あと13");
  });
  it("RSI in the zone falls back to the status word", () => {
    expect(
      chipDetailLine(chip({ key: "rsi", label: "RSI", status: "圏内" }), dec),
    ).toBe("RSI 圏内：今 58.2");
  });
  it("MACD unmet shows current and previous histogram", () => {
    expect(
      chipDetailLine(
        chip({ key: "macd", label: "MACD", status: "下向き" }),
        dec,
      ),
    ).toBe("MACD 下向き：ヒストグラム -0.0012（前回 -0.0015）");
  });
});
