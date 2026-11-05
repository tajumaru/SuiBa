import { describe, expect, it } from "vitest";
import {
  calibText,
  calibrationStep,
  emptyCalib,
  loadForecastCalib,
  saveForecastCalib,
  type ForecastCalib,
} from "../apps/dashboard/src/forecastCalib.ts";
import type { ForecastScore } from "../apps/dashboard/src/forecastLog.ts";

const score = (scoredRecords: number, coveragePct: number | null): ForecastScore => ({
  scoredRecords,
  steps: scoredRecords * 24,
  coveragePct,
  dirTotal: 0,
  dirPct: null,
  touchTotal: 0,
  touchHits: 0,
});

const calib = (scale: number, scoredAt: number): ForecastCalib => ({
  scale,
  scoredAt,
});

describe("calibrationStep", () => {
  it("does nothing before the minimum sample or without coverage", () => {
    const c = emptyCalib();
    expect(calibrationStep(score(29, 50), c).calib).toBe(c);
    expect(calibrationStep(score(40, null), c).calib).toBe(c);
  });

  it("waits for a fresh batch of ten between evaluations", () => {
    const c = calib(1, 30);
    expect(calibrationStep(score(39, 50), c).calib).toBe(c);
    const step = calibrationStep(score(40, 65), c);
    expect(step.calib.scoredAt).toBe(40);
  });

  it("stays quiet inside the deadband but advances the batch mark", () => {
    const step = calibrationStep(score(40, 82), calib(1, 0));
    expect(step.changed).toBe(false);
    expect(step.calib).toEqual({ scale: 1, scoredAt: 40 });
  });

  it("widens a too-narrow cone and narrows a too-wide one, damped", () => {
    const wide = calibrationStep(score(40, 65), calib(1, 0));
    expect(wide.changed).toBe(true);
    expect(wide.calib.scale).toBeGreaterThan(1);
    expect(wide.calib.scale).toBeLessThanOrEqual(1.08);
    const narrow = calibrationStep(score(40, 95), calib(1.2, 0));
    expect(narrow.changed).toBe(true);
    expect(narrow.calib.scale).toBeLessThan(1.2);
    expect(narrow.calib.scale).toBeGreaterThanOrEqual(1.1);
  });

  it("clamps the scale so the cone can never run away", () => {
    expect(calibrationStep(score(40, 40), calib(1.45, 0)).calib.scale).toBe(1.5);
    expect(calibrationStep(score(40, 100), calib(0.75, 0)).calib.scale).toBe(0.7);
  });
});

describe("calib storage", () => {
  const fake = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
  };

  it("round-trips per pair and falls back on junk", () => {
    const s = fake();
    saveForecastCalib(calib(1.12, 50), "SUI_USDC", s);
    saveForecastCalib(calib(0.9, 30), "WAL_USDC", s);
    expect(loadForecastCalib("SUI_USDC", s)).toEqual(calib(1.12, 50));
    expect(loadForecastCalib("WAL_USDC", s)).toEqual(calib(0.9, 30));
    s.setItem("suiba.forecastCalib.v1", "{\"scale\": 9}");
    expect(loadForecastCalib("SUI_USDC", s)).toEqual(emptyCalib());
  });
});

describe("calibText", () => {
  it("tells a widening with its numbers", () => {
    const text = calibText({
      at: 0,
      scale: 1.08,
      scored: 40,
      coveragePct: 65,
      widened: true,
    });
    expect(text).toContain("学習：ここまでの予測40件、収まり率は65%");
    expect(text).toContain("広げたよ（×1.08）");
  });
});
