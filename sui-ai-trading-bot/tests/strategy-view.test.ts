import { describe, expect, it } from "vitest";
import { defaults } from "../packages/shared/src/index.ts";
import type { DecisionTelemetry } from "../apps/worker/src/operations.ts";
import { fields } from "../apps/dashboard/src/SettingsPage.tsx";
import {
  MAX_INDICATOR_HISTORY,
  STRATEGY_PARAM_GROUPS,
  appendIndicatorPoint,
  emaVizData,
  isFreshDecision,
  macdBars,
  paramScale,
  scaleFraction,
  settingRange,
  strategyConditions,
  verdictTone,
  type IndicatorPoint,
} from "../apps/dashboard/src/strategyView.ts";

const NOW = Date.UTC(2026, 0, 2, 3, 0, 0);

function telemetry(
  overrides: Omit<Partial<DecisionTelemetry>, "conditions"> & {
    conditions?: Partial<DecisionTelemetry["conditions"]>;
  } = {},
): DecisionTelemetry {
  const { conditions, ...rest } = overrides;
  return {
    evaluatedAt: NOW - 60_000,
    candleTimestamp: NOW - 300_000,
    action: "WAIT",
    reason: "条件未成立",
    selectedRule: "NO_SIGNAL",
    sellPurpose: null,
    price: 2.412,
    entryPrice: null,
    ema20: 2.438,
    ema50: 2.421,
    rsi: 41,
    previousRsi: 28,
    histogram: -0.0012,
    previousHistogram: -0.0015,
    atr: 0.02,
    volumeChange: 0.6,
    oversold: 30,
    overbought: 70,
    stopLossPct: 0.02,
    takeProfitPct: 0.04,
    ...rest,
    conditions: {
      emaUp: true,
      emaGapShrinking: false,
      rsiRecovery: true,
      histogramImproving: false,
      hasPosition: false,
      stopLoss: false,
      takeProfit: false,
      ...(conditions ?? {}),
    },
  };
}

const point = (at: number, histogram = 0): IndicatorPoint => ({
  evaluatedAt: at,
  price: 2.4,
  ema20: 2.41,
  ema50: 2.4,
  rsi: 40,
  histogram,
});

describe("strategy view: decision freshness (fail-closed)", () => {
  it("accepts a fresh, finite decision", () => {
    expect(isFreshDecision(telemetry(), NOW)).toBe(true);
  });

  it("rejects missing, stale, future and non-finite evidence", () => {
    expect(isFreshDecision(null, NOW)).toBe(false);
    expect(isFreshDecision(undefined, NOW)).toBe(false);
    expect(
      isFreshDecision(
        telemetry({
          evaluatedAt: NOW - 400_000,
          candleTimestamp: NOW - 400_000,
        }),
        NOW,
      ),
    ).toBe(false);
    expect(isFreshDecision(telemetry({ evaluatedAt: NOW + 1 }), NOW)).toBe(
      false,
    );
    expect(isFreshDecision(telemetry({ rsi: Number.NaN }), NOW)).toBe(false);
    expect(isFreshDecision(telemetry({ price: 0 }), NOW)).toBe(false);
    expect(isFreshDecision(telemetry({ histogram: Infinity }), NOW)).toBe(
      false,
    );
  });
});

describe("strategy view: indicator history accumulation", () => {
  it("appends one point per new decision and ignores re-deliveries", () => {
    const first = appendIndicatorPoint([], telemetry(), NOW);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ema20: 2.438, histogram: -0.0012 });
    // The same snapshot polled again changes nothing.
    expect(appendIndicatorPoint(first, telemetry(), NOW)).toEqual(first);
    // An older decision arriving late is not appended either.
    const older = telemetry({
      evaluatedAt: NOW - 120_000,
      candleTimestamp: NOW - 300_000,
    });
    expect(appendIndicatorPoint(first, older, NOW)).toEqual(first);
    // A genuinely newer decision is appended.
    const newer = telemetry({ evaluatedAt: NOW - 30_000 });
    expect(appendIndicatorPoint(first, newer, NOW)).toHaveLength(2);
  });

  it("never records stale evidence and caps the history", () => {
    const stale = telemetry({ evaluatedAt: NOW - 400_000 });
    expect(appendIndicatorPoint([], stale, NOW)).toEqual([]);
    let history: IndicatorPoint[] = [];
    for (let i = 0; i < MAX_INDICATOR_HISTORY + 3; i++)
      history = appendIndicatorPoint(
        history,
        telemetry({ evaluatedAt: NOW - 60_000 + i * 1000 }),
        NOW,
      );
    expect(history).toHaveLength(MAX_INDICATOR_HISTORY);
    expect(history.at(-1)?.evaluatedAt).toBe(
      NOW - 60_000 + (MAX_INDICATOR_HISTORY + 2) * 1000,
    );
  });
});

describe("strategy view: condition cards", () => {
  it("takes states from the recorded condition flags", () => {
    const c = strategyConditions(telemetry(), 4, NOW);
    expect(c.ema.state).toBe("met");
    expect(c.rsi.state).toBe("met");
    expect(c.macd.state).toBe("unmet");
    expect(c.metCount).toBe(2);
    expect(c.ema.gapPct).toBeCloseTo((2.438 - 2.421) / 2.412);
    const none = strategyConditions(
      telemetry({
        conditions: {
          emaUp: false,
          emaGapShrinking: false,
          rsiRecovery: false,
          histogramImproving: true,
        },
      }),
      4,
      NOW,
    );
    expect(none.ema.state).toBe("unmet");
    expect(none.macd.state).toBe("met");
    expect(none.metCount).toBe(1);
  });

  it("marks an EMA met via the shrink route as viaShrink", () => {
    const c = strategyConditions(
      telemetry({
        ema20: 2.41,
        ema50: 2.42,
        conditions: { emaUp: true, emaGapShrinking: true },
      }),
      4,
      NOW,
    );
    expect(c.ema.state).toBe("met");
    expect(c.ema.viaShrink).toBe(true);
    expect(c.ema.gapPct).toBeLessThan(0);
    // The plain cross route is not a shrink.
    expect(strategyConditions(telemetry(), 4, NOW).ema.viaShrink).toBe(false);
  });

  it("judges the volume guard by the strategy's own comparison", () => {
    expect(strategyConditions(telemetry(), 4, NOW).volume).toEqual({
      state: "ok",
      multiple: 1.6,
      limit: 4,
    });
    expect(
      strategyConditions(telemetry({ volumeChange: 4.5 }), 4, NOW).volume.state,
    ).toBe("exceeded");
    expect(
      strategyConditions(telemetry({ volumeChange: -4.5 }), 4, NOW).volume
        .state,
    ).toBe("exceeded");
    // Exactly at the limit is not an exceedance (the rule uses >).
    expect(
      strategyConditions(telemetry({ volumeChange: 4 }), 4, NOW).volume.state,
    ).toBe("ok");
  });

  it("shows unknown — never a guessed colour — without fresh evidence", () => {
    for (const dec of [
      null,
      telemetry({ evaluatedAt: NOW - 400_000, candleTimestamp: NOW - 400_000 }),
    ]) {
      const c = strategyConditions(dec, 4, NOW);
      expect(c.ema.state).toBe("unknown");
      expect(c.rsi.state).toBe("unknown");
      expect(c.macd.state).toBe("unknown");
      expect(c.volume.state).toBe("unknown");
      expect(c.volume.multiple).toBeNull();
      expect(c.metCount).toBeNull();
    }
  });
});

describe("strategy view: mini chart data", () => {
  it("MACD bars fall back to the recorded previous/current pair", () => {
    expect(macdBars([], telemetry(), NOW)).toEqual([-0.0015, -0.0012]);
  });

  it("MACD bars come from accumulated history without duplicating the current decision", () => {
    const history = [point(NOW - 120_000, -0.004), point(NOW - 90_000, -0.002)];
    expect(macdBars(history, telemetry(), NOW)).toEqual([
      -0.004, -0.002, -0.0012,
    ]);
    const withCurrent = [...history, point(NOW - 60_000, -0.0012)];
    expect(macdBars(withCurrent, telemetry(), NOW)).toEqual([
      -0.004, -0.002, -0.0012,
    ]);
    expect(macdBars([], null, NOW)).toEqual([]);
  });

  it("EMA viz is a level view until two decisions are recorded, then a series", () => {
    expect(emaVizData([], telemetry(), NOW)).toEqual({
      kind: "levels",
      price: 2.412,
      ema20: 2.438,
      ema50: 2.421,
    });
    const series = emaVizData([point(NOW - 120_000)], telemetry(), NOW);
    expect(series.kind).toBe("series");
    if (series.kind === "series") {
      expect(series.ema20).toEqual([2.41, 2.438]);
      expect(series.ema50).toEqual([2.4, 2.421]);
    }
    expect(emaVizData([], null, NOW)).toEqual({ kind: "none" });
  });
});

describe("strategy view: parameter groups and scales", () => {
  it("places every settings field in exactly one group", () => {
    const grouped = STRATEGY_PARAM_GROUPS.flatMap((g) =>
      g.params.map((p) => p.key),
    );
    expect([...grouped].sort()).toEqual(fields.map((f) => f.key).sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(STRATEGY_PARAM_GROUPS.map((g) => g.title)).toEqual([
      "買い条件",
      "売り・リスク",
      "ProfitGuard（利益保護）",
    ]);
  });

  it("reads selectable ranges from the shared schema, not copies", () => {
    expect(settingRange("oversold")).toEqual({ min: 10, max: 45 });
    expect(settingRange("overbought")).toEqual({ min: 55, max: 90 });
    expect(settingRange("maxOrder")).toEqual({ min: 0, max: 5 });
    expect(settingRange("dailyBuyLimit")).toEqual({ min: 0, max: 20 });
    expect(settingRange("dailyLossPct")).toEqual({ min: 0, max: 0.01 });
    expect(settingRange("maxSlippage")).toEqual({ min: 0, max: 0.003 });
    expect(settingRange("maxHoldingRatio")).toEqual({ min: 0, max: 0.2 });
    expect(settingRange("intervalMs")).toEqual({ min: 30000, max: 3600000 });
    expect(settingRange("stopLossPct")).toEqual({ min: 0, max: 0.1 });
    expect(settingRange("takeProfitPct")).toEqual({ min: 0, max: 0.3 });
    expect(settingRange("maxVolumeChange")).toEqual({ min: 0, max: 20 });
    expect(settingRange("feeRate")).toEqual({ min: 0, max: 0.01 });
    expect(settingRange("gasUsdc")).toEqual({ min: 0, max: 1 });
    expect(settingRange("minNetProfitUsdc")).toEqual({ min: 0, max: 5 });
    expect(settingRange("minNetProfitPct")).toEqual({ min: 0, max: 1 });
    expect(settingRange("emaGapShrinkCandles")).toEqual({ min: 2, max: 10 });
  });

  it("positions markers and selectable bands inside the display domain", () => {
    const def = (key: string) =>
      STRATEGY_PARAM_GROUPS.flatMap((g) => g.params).find(
        (p) => p.key === key,
      )!;
    // RSI buy line: domain is the RSI scale 0–100, selectable 10–45.
    expect(paramScale(defaults, def("oversold"))).toMatchObject({
      value: 30,
      domainMin: 0,
      domainMax: 100,
      bandLeft: 0.1,
      marker: 0.3,
    });
    expect(paramScale(defaults, def("oversold")).bandWidth).toBeCloseTo(0.35);
    // Stop loss: domain is the selectable range itself, band fills it.
    expect(paramScale(defaults, def("stopLossPct"))).toMatchObject({
      value: 0.02,
      domainMin: 0,
      domainMax: 0.1,
      bandLeft: 0,
      bandWidth: 1,
    });
    expect(paramScale(defaults, def("stopLossPct")).marker).toBeCloseTo(0.2);
    // Holding ratio: domain is the whole 0–100%, selectable caps at 20%.
    expect(paramScale(defaults, def("maxHoldingRatio"))).toMatchObject({
      domainMin: 0,
      domainMax: 1,
      bandWidth: 0.2,
      marker: 0.2,
    });
    expect(scaleFraction(2, 0, 1)).toBe(1);
    expect(scaleFraction(-1, 0, 1)).toBe(0);
    expect(scaleFraction(Number.NaN, 0, 1)).toBe(0);
  });

  it("maps decision actions to verdict tones", () => {
    expect(verdictTone("BUY")).toBe("buy");
    expect(verdictTone("SELL")).toBe("sell");
    expect(verdictTone("WAIT")).toBe("wait");
    expect(verdictTone(null)).toBe("none");
    expect(verdictTone("SOMETHING_ELSE")).toBe("none");
  });
});
