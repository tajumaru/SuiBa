import { candleGeometry } from "../apps/dashboard/src/candleGeometry.ts";
import { it, expect } from "vitest";
import {
  chartSeries,
  lineSegments,
} from "../apps/dashboard/src/chartIndicators.ts";
import { calculate } from "../packages/indicators/src/index.ts";
import { chartFixture } from "./chart-fixture.ts";
it("display indicators equal existing calculations at multiple prefixes", () => {
  const c = chartFixture(),
    series = chartSeries(c);
  for (const i of [59, 120, 500, 999]) {
    const original = calculate(c.slice(0, i + 1));
    for (const key of [
      "ema20",
      "ema50",
      "rsi",
      "macd",
      "signal",
      "histogram",
    ] as const)
      expect(series[key][i]).toBe(original[key]);
  }
  expect(series.rsi[58]).toBeNull();
});
it("gaps break paths and restart preparation instead of interpolating", () => {
  const c = chartFixture().slice(0, 140);
  c.splice(70, 1);
  const s = chartSeries(c);
  expect(s.rsi[69]).not.toBeNull();
  expect(s.rsi[70]).toBeNull();
  expect(s.ema50[70]).toBeNull();
  expect(
    lineSegments(
      c,
      s.ema20,
      (t) => t,
      (v) => v,
    ),
  ).toHaveLength(2);
  expect(s.rsi.at(-1)).not.toBeNull();
});
it("computes 2136 consecutive bars without changing values or inputs", () => {
  const base = chartFixture();
  const c = Array.from({ length: 2136 }, (_, i) => ({
    ...base[i % 1000],
    timestamp: base[0].timestamp + i * 300,
  }));
  const before = JSON.stringify(c),
    started = performance.now(),
    s = chartSeries(c),
    ms = performance.now() - started;
  expect(s.rsi).toHaveLength(2136);
  expect(s.macd.at(-1)).toBe(calculate(c).macd);
  expect(JSON.stringify(c)).toBe(before);
  console.info(JSON.stringify({ chartSeriesBars: 2136, elapsedMs: ms }));
});

it("SVG batching preserves every wick and body rather than sampling", () => {
  const base = chartFixture(),
    c = Array.from({ length: 2016 }, (_, i) => ({
      ...base[i % 1000],
      timestamp: base[0].timestamp + i * 300,
    }));
  const geometry = candleGeometry(
    c,
    (t) => t,
    (v) => v,
    1,
  );
  expect(
    geometry.groups.reduce((n, g) => n + (g.wick.match(/M /g)?.length ?? 0), 0),
  ).toBe(2016);
  expect(
    geometry.groups.reduce((n, g) => n + (g.body.match(/M /g)?.length ?? 0), 0),
  ).toBe(2016);
  expect(geometry.groups[0].wick).toContain(`V ${c[0].low}`);
  expect(geometry.groups[0].wick).toContain(`${c[0].high} V`);
});
