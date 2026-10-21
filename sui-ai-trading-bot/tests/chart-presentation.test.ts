import { describe, it, expect } from "vitest";
import {
  chartData,
  chartWindow,
  chartTime,
  chartTicks,
} from "../apps/dashboard/src/chartPresentation.ts";
import { ema, calculate } from "../packages/indicators/src/index.ts";
import type { Candle } from "../packages/shared/src/index.ts";
import { chartFixture } from "./chart-fixture.ts";
describe("display-only chart windows", () => {
  it("uses JST and handles midnight", () => {
    expect(chartTime(Date.UTC(2026, 9, 22, 15) / 1000)).toBe(
      "2026/10/23 00:00",
    );
    expect(chartTime(Date.UTC(2026, 9, 22, 14, 55) / 1000)).toBe(
      "2026/10/22 23:55",
    );
  });
  for (const hours of [1, 6, 24, 168])
    it(`selects ${hours}h from actual bars without mutating inputs or indicators`, () => {
      const candles = chartFixture(),
        before = JSON.stringify(candles),
        decision = calculate(candles);
      const data = chartData(candles),
        v = chartWindow(data, hours * 3600);
      expect(v.end).toBe(candles.at(-1)!.timestamp + 300);
      expect(v.start).toBe(v.candles[0].timestamp);
      expect(v.candles.length).toBe(Math.min(1000, hours * 12));
      const offset = candles.findIndex((b) => b.timestamp === v.start);
      expect(v.ema20).toEqual(
        ema(
          candles.map((b) => b.close),
          20,
        ).slice(offset),
      );
      expect(v.ema50).toEqual(
        ema(
          candles.map((b) => b.close),
          50,
        ).slice(offset),
      );
      expect(calculate(candles)).toEqual(decision);
      expect(JSON.stringify(candles)).toBe(before);
    });
  it("pans and restores latest using candle timestamps rather than the clock", () => {
    const d = chartData(chartFixture());
    const latest = chartWindow(d, 3600),
      old = chartWindow(d, 3600, latest.end! - 3600);
    expect(old.end).toBe(latest.end! - 3600);
    expect(chartWindow(d, 3600).end).toBe(latest.end);
    expect(chartWindow(d, 1800).candles).toHaveLength(6);
  });
  it("sorts copies, rejects duplicates and leaves gaps unfilled", () => {
    const c = chartFixture().slice(0, 5);
    expect(chartData([...c].reverse()).candles).toEqual(c);
    expect(chartData([...c, c[0]]).candles).toEqual([]);
    expect(chartWindow(chartData([c[0], c[4]]), 3600).candles).toHaveLength(2);
  });
  it("formats date-crossing ticks in ascending order with width-dependent density", () => {
    const c = chartFixture();
    const ticks = chartTicks(c, 320);
    expect(ticks.length).toBeLessThanOrEqual(2);
    expect(ticks[0].label).toMatch(/10\/20/);
    expect(chartTicks(c, 1200).length).toBeGreaterThan(ticks.length);
    expect(ticks.map((t) => t.timestamp)).toEqual(
      [...ticks.map((t) => t.timestamp)].sort((a, b) => a - b),
    );
  });
  it("has no fabricated interval for missing data", () => {
    expect(chartWindow(chartData([]), 3600)).toMatchObject({
      start: null,
      end: null,
    });
  });
  it("keeps ticks apart when a long missing interval clusters candles", () => {
    const original = chartFixture();
    const candles = [original[0], ...original.slice(-30)];
    const ticks = chartTicks(candles, 1000),
      range = candles.at(-1)!.timestamp - candles[0].timestamp;
    for (let i = 1; i < ticks.length; i++)
      expect(
        ((ticks[i].timestamp - ticks[i - 1].timestamp) / range) * 1000,
      ).toBeGreaterThanOrEqual(125);
  });
});
