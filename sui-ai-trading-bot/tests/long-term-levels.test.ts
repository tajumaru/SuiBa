import { describe, expect, it } from "vitest";
import type { DailyCandle } from "../packages/shared/src/index.ts";
import {
  longTermLevels,
  longTermTrend,
  spreadLabelYs,
  toWeekly,
} from "../apps/dashboard/src/longTermLevels.ts";

const DAY = 86400;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function series(
  startIso: string,
  days: number,
  open: (i: number, t: number) => number,
  wave = 0,
): DailyCandle[] {
  const start = T(startIso);
  return Array.from({ length: days }, (_, i) => {
    const o = open(i, start + i * DAY);
    const w = wave ? Math.sin(i / 9) * wave : 0;
    return {
      timestamp: start + i * DAY,
      open: o,
      high: o + 0.05 + Math.abs(w),
      low: o - 0.05 - Math.abs(w),
      close: o + w,
      volume: 10,
    };
  });
}

describe("longTermLevels", () => {
  it("names the period opens the series covers, plus the extremes", () => {
    // 2025-12-20 .. ~2026-11-14: covers the 2026 year open,
    // the Q4 open and the November open.
    const daily = series("2025-12-20T00:00:00Z", 330, (i, t) => {
      if (t === T("2026-01-01T00:00:00Z")) return 1.403;
      if (t === T("2026-10-01T00:00:00Z")) return 0.875;
      if (t === T("2026-11-01T00:00:00Z")) return 1.02;
      return 1.0;
    });
    const levels = longTermLevels(daily);
    const by = (k: string) => levels.find((l) => l.kind === k);
    expect(by("yearOpen")?.price).toBe(1.403);
    expect(by("quarterOpen")?.price).toBe(0.875);
    expect(by("monthOpen")?.price).toBe(1.02);
    expect(by("high")?.price).toBeGreaterThan(1.403);
    expect(by("low")?.price).toBeLessThan(0.875);
  });

  it("omits a period open the series does not cover", () => {
    // Starts mid-year: no 2026 year open may be claimed.
    const daily = series("2026-06-01T00:00:00Z", 158, () => 1.0);
    const kinds = longTermLevels(daily).map((l) => l.kind);
    expect(kinds).not.toContain("yearOpen");
    expect(kinds).toContain("quarterOpen");
    expect(kinds).toContain("monthOpen");
  });

  it("needs a month of days before naming anything", () => {
    expect(longTermLevels(series("2026-10-01T00:00:00Z", 10, () => 1))).toEqual([]);
  });
});

describe("longTermTrend", () => {
  it("draws a descending resistance from two lower swing highs", () => {
    // Peaks near day 20 (3.0) and day 90 (2.4), price now below.
    const daily = series("2026-01-01T00:00:00Z", 200, (i) => {
      const peak = (c: number, h: number) =>
        Math.max(0, 1 - Math.abs(i - c) / 18) * h;
      return 1 + peak(20, 2.0) + peak(90, 1.4) + peak(150, 0.7);
    });
    const trend = longTermTrend(daily);
    expect(trend?.kind).toBe("resistance");
    expect(trend!.p1).toBeGreaterThan(trend!.p2);
  });

  it("draws nothing on a short series", () => {
    expect(longTermTrend(series("2026-10-01T00:00:00Z", 40, () => 1))).toBeNull();
  });
});

describe("toWeekly", () => {
  it("aggregates daily candles into OHLC weeks", () => {
    const daily = series("2026-10-05T00:00:00Z", 14, (i) => 1 + i * 0.01);
    const weekly = toWeekly(daily);
    expect(weekly.length).toBeGreaterThanOrEqual(2);
    expect(weekly.length).toBeLessThanOrEqual(3);
    const first = weekly[0];
    expect(first.open).toBe(daily[0].open);
    expect(first.high).toBeGreaterThanOrEqual(first.close);
    const total = weekly.reduce((a, w) => a + w.volume, 0);
    expect(total).toBe(140);
  });
});

describe("spreadLabelYs", () => {
  it("separates piled-up labels by the gap, in order", () => {
    const out = spreadLabelYs([100, 102, 101], 11, 9, 237);
    expect(out[0]).toBe(100);
    expect(out[2]).toBe(111);
    expect(out[1]).toBe(122);
  });

  it("leaves sparse labels where they are", () => {
    expect(spreadLabelYs([20, 120, 220], 11, 9, 237)).toEqual([20, 120, 220]);
  });

  it("pulls a bottom pile-up back inside the plot", () => {
    const out = spreadLabelYs([230, 232], 11, 9, 237);
    expect(out[1]).toBeLessThanOrEqual(237);
    expect(out[1] - out[0]).toBeGreaterThanOrEqual(11);
  });
});
