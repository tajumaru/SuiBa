import { describe, expect, it } from "vitest";
import {
  activityMonthLabels,
  buildActivityWeeks,
} from "../apps/dashboard/src/ActivityGrass.tsx";

// Local-time construction keeps the expectations timezone-proof.
const at = (y: number, m: number, d: number, h = 12) =>
  new Date(y, m - 1, d, h).getTime();
const order = (ts: number, status = "FILLED") => ({ timestamp: ts, status });

describe("activity grass", () => {
  const now = at(2026, 11, 1, 15); // a Sunday

  it("builds 18 Sunday-first weeks ending with today", () => {
    const weeks = buildActivityWeeks([], now);
    expect(weeks).toHaveLength(18);
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    const last = weeks[17];
    expect(last[0].isToday).toBe(true); // today is the Sunday
    expect(last[0].weekday).toBe(0);
    expect(last.slice(1).every((d) => d.isFuture)).toBe(true);
  });

  it("levels days by fills first, then attempts", () => {
    const day = at(2026, 10, 31); // yesterday, in the last week
    const weeks = buildActivityWeeks(
      [
        order(day, "FILLED"),
        order(day + 1000, "FILLED"),
        order(day + 2000, "FILLED"),
        order(day + 3000, "REJECTED"),
      ],
      now,
    );
    const cellOf = (grid: ReturnType<typeof buildActivityWeeks>) =>
      grid.flat().find((d) => d.dateKey === "2026-10-31")!;
    const cell = cellOf(weeks);
    expect(cell.fills).toBe(3);
    expect(cell.orders).toBe(4);
    expect(cell.level).toBe(4);
    expect(cell.weekday).toBe(6); // Saturday of the final week
    const attemptsOnly = buildActivityWeeks([order(day, "REJECTED")], now);
    expect(cellOf(attemptsOnly).level).toBe(1);
    const oneFill = buildActivityWeeks([order(day)], now);
    expect(cellOf(oneFill).level).toBe(2);
  });

  it("ignores orders without a usable timestamp", () => {
    const weeks = buildActivityWeeks(
      [{ status: "FILLED" }, { timestamp: "x", status: "FILLED" }],
      now,
    );
    expect(weeks.flat().every((d) => d.orders === 0)).toBe(true);
  });

  it("labels the month where it changes", () => {
    const labels = activityMonthLabels(buildActivityWeeks([], now));
    expect(labels[0].week).toBe(0);
    expect(labels.map((l) => l.label)).toContain("11月");
    expect(labels.map((l) => l.label)).toContain("10月");
  });
});
