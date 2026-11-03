import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { downsampleEquityCurve } from "../apps/worker/src/engine.ts";
import {
  equityCurveModel,
  formatDelta,
  type EquityPoint,
} from "../apps/dashboard/src/equityCurve.ts";
import { EquityCurve } from "../apps/dashboard/src/EquityCurve.tsx";

const HOUR = 3600 * 1000;
const NOW = 1_800_000_000_000;

describe("downsampleEquityCurve", () => {
  it("keeps the last point of each hour inside 30 days", () => {
    const points = [
      { timestamp: NOW - 31 * 24 * HOUR, equity: 99 }, // too old
      { timestamp: NOW - 2 * HOUR, equity: 100 },
      { timestamp: NOW - 2 * HOUR + 60000, equity: 100.5 }, // same hour, later
      { timestamp: NOW - HOUR, equity: 101 },
      { timestamp: NOW, equity: Number.NaN }, // not a number outcome
      { timestamp: NOW, equity: 102 },
    ];
    const out = downsampleEquityCurve(points, NOW);
    expect(out).toEqual([
      { t: NOW - 2 * HOUR + 60000, equity: 100.5 },
      { t: NOW - HOUR, equity: 101 },
      { t: NOW, equity: 102 },
    ]);
  });
  it("returns nothing for an empty history", () => {
    expect(downsampleEquityCurve([], NOW)).toEqual([]);
  });
});

describe("equityCurveModel", () => {
  const pts: EquityPoint[] = [
    { t: NOW - 10 * 24 * HOUR, equity: 100 },
    { t: NOW - 3 * 24 * HOUR, equity: 99.5 },
    { t: NOW - HOUR, equity: 100.42 },
  ];
  it("slices to the range and computes the delta", () => {
    const m = equityCurveModel(pts, "7d", NOW);
    expect(m?.points).toHaveLength(2);
    expect(m?.first).toBe(99.5);
    expect(m?.last).toBe(100.42);
    expect(m?.delta).toBeCloseTo(0.92);
    expect(m?.deltaPct).toBeCloseTo(0.9246, 3);
    expect(m?.min).toBe(99.5);
    expect(m?.max).toBe(100.42);
  });
  it("needs at least two points in range", () => {
    expect(equityCurveModel(pts, "24h", NOW)).toBeNull();
    expect(equityCurveModel([], "7d", NOW)).toBeNull();
  });
  it("formats signed deltas", () => {
    expect(formatDelta(0.42, 0.42)).toBe("+0.42（+0.42%）");
    expect(formatDelta(-0.3, -0.3)).toBe("-0.30（-0.30%）");
    expect(formatDelta(0, 0)).toBe("0.00（0.00%）");
  });
});

describe("EquityCurve", () => {
  it("renders the curve with its delta", () => {
    const points: EquityPoint[] = Array.from({ length: 48 }, (_, i) => ({
      t: NOW - (47 - i) * HOUR,
      equity: 100 + i * 0.01,
    }));
    // Render relative to the real clock the component reads.
    const fresh = points.map((p) => ({
      ...p,
      t: Date.now() - (NOW - p.t),
    }));
    const html = renderToStaticMarkup(createElement(EquityCurve, { points: fresh }));
    expect(html).toContain("資産の推移");
    expect(html).toContain("7日で");
    expect(html).toContain("+0.47");
    expect(html).toContain("polyline");
  });
  it("shows the collecting note without points", () => {
    const html = renderToStaticMarkup(createElement(EquityCurve, { points: [] }));
    expect(html).toContain("集計中");
  });
});
