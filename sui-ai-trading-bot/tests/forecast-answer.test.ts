import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Candle } from "../packages/shared/src/index.ts";
import { chartForecast } from "../apps/dashboard/src/chartForecast.ts";
import {
  answerCheckText,
  forecastRecordFrom,
  latestAnswerCheck,
  loadForecastLog,
  saveForecastLog,
  type ForecastAnswerCheck,
  type ForecastRecord,
} from "../apps/dashboard/src/forecastLog.ts";
import { PriceChart } from "../apps/dashboard/src/PriceChart.tsx";

const T0 = Date.UTC(2026, 10, 1, 0) / 1000;
function candles(closes: number[], range = 0.01): Candle[] {
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

function fakeStorage() {
  const backing = new Map<string, string>();
  return {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
  };
}

/** A record projected from the candle at index `at`: mid drifts
 * linearly to `drift` over 24 steps, band ±`band` around it. */
function record(
  cs: Candle[],
  at: number,
  dir: ForecastRecord["dir"],
  drift: number,
  band: number,
  withMid = true,
): ForecastRecord {
  const startClose = cs[at].close;
  const mid = Array.from(
    { length: 24 },
    (_, j) => startClose * (1 + (drift * (j + 1)) / 24),
  );
  return {
    origin: cs[at + 1].timestamp,
    startClose,
    dir,
    mid: withMid ? mid : undefined,
    up: mid.map((m) => m * (1 + band)),
    lo: mid.map((m) => m * (1 - band)),
  };
}

describe("forecast records carry the centre line", () => {
  it("snapshots mid and round-trips it; old records still load", () => {
    const cs = candles(Array.from({ length: 60 }, (_, i) => 2 + i * 0.012));
    const rec = forecastRecordFrom(chartForecast(cs)!, cs.at(-1)!.close);
    expect(rec.mid).toHaveLength(24);
    const storage = fakeStorage();
    saveForecastLog([rec], "SUI_USDC", storage);
    expect(loadForecastLog("SUI_USDC", storage)[0].mid).toEqual(rec.mid);

    const { mid: _dropped, ...oldShape } = rec;
    saveForecastLog([oldShape as ForecastRecord], "SUI_USDC", storage);
    const loaded = loadForecastLog("SUI_USDC", storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].mid).toBeUndefined();
  });
});

describe("latestAnswerCheck", () => {
  // Origin at index 40; the outcome window is bars 41..64.
  const risingOutcome = candles([
    ...Array.from({ length: 41 }, (_, i) => 2 + i * 0.002),
    ...Array.from({ length: 24 }, (_, j) => 2.082 + (j + 1) * 0.002),
    ...Array.from({ length: 5 }, () => 2.13),
  ]);

  it("builds the check for a finished, recorded forecast", () => {
    const rec = record(risingOutcome, 40, "up", 0.01, 0.02);
    const check = latestAnswerCheck([rec], risingOutcome)!;
    expect(check).not.toBeNull();
    expect(check.origin).toBe(rec.origin);
    expect(check.driftPct).toBeCloseTo(0.01);
    expect(check.actualPct).toBeGreaterThan(0);
    expect(check.directionHit).toBe(true);
    expect(check.coveragePct).toBe(100);
    expect(check.points).toHaveLength(24);
    expect(check.actuals.at(-1)!.close).toBeCloseTo(2.13);
    expect(answerCheckText(check)).toContain("方向 的中");
    expect(answerCheckText(check)).toContain("コーン収まり 100%");
  });

  it("calls a miss a miss, with the realised coverage", () => {
    const fallingOutcome = candles([
      ...Array.from({ length: 41 }, (_, i) => 2 + i * 0.002),
      ...Array.from({ length: 24 }, (_, j) => 2.082 - (j + 1) * 0.004),
      ...Array.from({ length: 5 }, () => 1.98),
    ]);
    const rec = record(fallingOutcome, 40, "up", 0.01, 0.004);
    const check = latestAnswerCheck([rec], fallingOutcome)!;
    expect(check.directionHit).toBe(false);
    expect(check.actualPct).toBeLessThan(0);
    expect(check.coveragePct).toBeLessThan(100);
    expect(answerCheckText(check)).toContain("方向 外れ");
  });

  it("makes no direction claim for a flat forecast", () => {
    const rec = record(risingOutcome, 40, "flat", 0.001, 0.02);
    const check = latestAnswerCheck([rec], risingOutcome)!;
    expect(check.directionHit).toBeNull();
    expect(answerCheckText(check)).toContain("方向は名乗らず");
  });

  it("skips records without a centre line, unfinished ones and antiques", () => {
    const noMid = record(risingOutcome, 40, "up", 0.01, 0.02, false);
    expect(latestAnswerCheck([noMid], risingOutcome)).toBeNull();

    const shortCandles = risingOutcome.slice(0, 50); // outcome incomplete
    const rec = record(risingOutcome, 40, "up", 0.01, 0.02);
    expect(latestAnswerCheck([rec], shortCandles)).toBeNull();

    const longCandles = candles(
      Array.from({ length: 200 }, (_, i) => 2 + i * 0.001),
    );
    const antique = record(longCandles, 40, "up", 0.01, 0.02);
    expect(latestAnswerCheck([antique], longCandles)).toBeNull();
  });

  it("prefers the newest eligible record", () => {
    const older = record(risingOutcome, 30, "up", 0.01, 0.02);
    const newer = record(risingOutcome, 40, "down", -0.01, 0.02);
    const check = latestAnswerCheck([older, newer], risingOutcome)!;
    expect(check.origin).toBe(newer.origin);
  });
});

describe("PriceChart answer-check view", () => {
  const cs = candles(Array.from({ length: 60 }, (_, i) => 2 + i * 0.012));
  const startClose = cs[35].close;
  const check: ForecastAnswerCheck = {
    origin: cs[36].timestamp,
    startClose,
    dir: "up",
    driftPct: 0.01,
    actualPct: 0.028,
    coveragePct: 100,
    directionHit: true,
    points: Array.from({ length: 24 }, (_, j) => {
      const mid = startClose * (1 + (0.01 * (j + 1)) / 24);
      return {
        timestamp: cs[36 + j].timestamp,
        mid,
        upper: mid * 1.02,
        lower: mid * 0.98,
      };
    }),
    actuals: Array.from({ length: 24 }, (_, j) => ({
      timestamp: cs[36 + j].timestamp,
      close: cs[36 + j].close,
    })),
  };
  const render = (extra: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      React.createElement(PriceChart, {
        candles: cs,
        trades: [],
        answerCheck: check,
        ...extra,
      }),
    );

  it("keeps the ghost hidden until the toggle is on", () => {
    const off = render();
    expect(off).toContain("chart-answer-toggle");
    expect(off).not.toContain('class="chart-answer"');
    const on = render({ answerDefaultOn: true });
    expect(on).toContain('class="chart-answer"');
    expect(on).toContain('stroke="#ffffff"');
    expect(on).toContain("2時間前の予測 → 実際");
    expect(on).toContain("予測 +1.0%");
    expect(on).toContain("実際 +2.8%");
    expect(on).toContain("方向 的中");
  });

  it("offers no toggle without a checkable forecast", () => {
    const html = renderToStaticMarkup(
      React.createElement(PriceChart, { candles: cs, trades: [] }),
    );
    expect(html).not.toContain("chart-answer-toggle");
  });
});
