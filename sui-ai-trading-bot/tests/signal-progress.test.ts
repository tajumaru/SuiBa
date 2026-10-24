import { describe, expect, it } from "vitest";
import type { SignalTelemetry } from "../apps/worker/src/operations.ts";
import { signalProgress } from "../apps/dashboard/src/signalProgress.ts";

const telemetry = (
  patch: Partial<SignalTelemetry> = {},
): SignalTelemetry => ({
  evaluatedAt: 1800000000000,
  candleTimestamp: 1799999700,
  action: "WAIT",
  selectedRule: "NO_SIGNAL",
  hasPosition: false,
  price: 2,
  current: { ema20: 2, ema50: 2, rsi: 30, histogram: 0, atr: 0.1 },
  previous: { rsi: 30, histogram: 0 },
  thresholds: { oversold: 30 },
  conditions: {
    emaUp: false,
    rsiRecovery: false,
    histogramImproving: false,
  },
  ...patch,
});

describe("signalProgress", () => {
  it("is unavailable without recorded evidence", () => {
    expect(signalProgress(null)).toEqual({
      available: false,
      reason: "no-data",
    });
    expect(signalProgress(undefined)).toEqual({
      available: false,
      reason: "no-data",
    });
  });

  it("is unavailable while a position is open", () => {
    expect(signalProgress(telemetry({ hasPosition: true }))).toEqual({
      available: false,
      reason: "has-position",
    });
  });

  it("reports every gauge at 100 when all conditions hold", () => {
    const p = signalProgress(
      telemetry({
        current: { ema20: 2.01, ema50: 2, rsi: 31, histogram: 0.01, atr: 0.1 },
        previous: { rsi: 30, histogram: 0 },
        conditions: {
          emaUp: true,
          rsiRecovery: true,
          histogramImproving: true,
        },
      }),
    );
    if (!p.available) throw new Error("expected available");
    expect(p.allMet).toBe(true);
    expect(p.phase).toBe("ready");
    expect(p.overall).toBe(100);
    expect(p.gauges.map((g) => g.progress)).toEqual([100, 100, 100]);
    expect(p.gauges.map((g) => g.remainingText)).toEqual(["", "", ""]);
  });

  it("trusts the strategy's recorded conditions instead of re-deciding", () => {
    // Spread is still negative, but the strategy recorded emaUp for
    // that cycle; the gauge must follow the record, not recompute.
    const p = signalProgress(
      telemetry({
        current: { ema20: 1.99, ema50: 2, rsi: 30, histogram: 0, atr: 0.1 },
        conditions: {
          emaUp: true,
          rsiRecovery: false,
          histogramImproving: false,
        },
      }),
    );
    if (!p.available) throw new Error("expected available");
    expect(p.gauges[0].met).toBe(true);
    expect(p.gauges[0].progress).toBe(100);
  });

  it("measures a far-from-entry state from real distances", () => {
    const p = signalProgress(
      telemetry({
        // EMA spread -2% of price (window 1%), RSI far above the
        // oversold line, histogram falling by 0.3 ATR.
        current: { ema20: 1.96, ema50: 2, rsi: 70, histogram: -0.02, atr: 0.1 },
        previous: { rsi: 69, histogram: 0.01 },
      }),
    );
    if (!p.available) throw new Error("expected available");
    expect(p.phase).toBe("far");
    expect(p.overall).toBe(0);
    expect(p.gauges[0].progress).toBe(0);
    expect(p.gauges[0].remainingText).toContain("あと2.00%");
    expect(p.gauges[1].remainingText).toContain("低下で売られすぎ圏");
    expect(p.gauges[2].progress).toBe(0);
  });

  it("tracks RSI below the oversold line as waiting for the cross up", () => {
    const p = signalProgress(
      telemetry({
        current: { ema20: 2, ema50: 2, rsi: 28, histogram: 0, atr: 0.1 },
        previous: { rsi: 29, histogram: 0 },
      }),
    );
    if (!p.available) throw new Error("expected available");
    const rsi = p.gauges[1];
    expect(rsi.met).toBe(false);
    expect(rsi.progress).toBe(80);
    expect(rsi.remainingText).toContain("あと2.0ポイント上昇で売られすぎ圏を上抜け");
  });

  it("classifies a bottleneck at 85+ as あと一歩", () => {
    const p = signalProgress(
      telemetry({
        // EMA spread -0.1% -> 90, RSI 0.5pt below the line -> 95,
        // MACD met -> bottleneck 90.
        current: { ema20: 1.998, ema50: 2, rsi: 29.5, histogram: 0.01, atr: 0.1 },
        previous: { rsi: 30, histogram: 0 },
        conditions: {
          emaUp: false,
          rsiRecovery: false,
          histogramImproving: true,
        },
      }),
    );
    if (!p.available) throw new Error("expected available");
    expect(p.gauges.map((g) => g.progress)).toEqual([90, 95, 100]);
    expect(p.overall).toBe(90);
    expect(p.phase).toBe("almost");
    expect(p.allMet).toBe(false);
  });

  it("classifies a mid-range bottleneck as approaching", () => {
    const p = signalProgress(
      telemetry({
        // EMA spread -0.4% of price -> 60 is the bottleneck.
        current: { ema20: 1.992, ema50: 2, rsi: 28, histogram: 0.009, atr: 0.1 },
        previous: { rsi: 29, histogram: 0.01 },
      }),
    );
    if (!p.available) throw new Error("expected available");
    expect(p.gauges[0].progress).toBe(60);
    expect(p.overall).toBe(60);
    expect(p.phase).toBe("approaching");
  });

  it("caps an unmet gauge at 99 so 100 always means 成立", () => {
    const p = signalProgress(
      telemetry({
        // Spread a hair below the crossing: raw progress rounds to
        // 100 but the recorded condition does not hold yet.
        current: { ema20: 1.99999, ema50: 2, rsi: 30, histogram: 0, atr: 0.1 },
        previous: { rsi: 30, histogram: 0 },
      }),
    );
    if (!p.available) throw new Error("expected available");
    expect(p.gauges[0].met).toBe(false);
    expect(p.gauges[0].progress).toBe(99);
  });

  it("degrades MACD progress gracefully when ATR is not positive", () => {
    const p = signalProgress(
      telemetry({
        current: { ema20: 2, ema50: 2, rsi: 30, histogram: -0.01, atr: 0 },
        previous: { rsi: 30, histogram: 0 },
      }),
    );
    if (!p.available) throw new Error("expected available");
    expect(Number.isFinite(p.gauges[2].progress)).toBe(true);
    expect(p.gauges[2].remainingText).toContain("上向きに転じれば成立");
  });
});
