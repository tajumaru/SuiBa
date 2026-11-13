import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EquityCurve } from "../apps/dashboard/src/EquityCurve.tsx";
import {
  attributeEquityHistory,
  type ValuationPoint,
} from "../apps/worker/src/equity-attribution.ts";
import { downsampleEquityCurve } from "../apps/worker/src/engine-snapshot.ts";
import { equityCurveModel } from "../apps/dashboard/src/equityCurve.ts";
import {
  buildMonthlyReport,
  monthKeyOf,
} from "../apps/dashboard/src/monthlyReport.ts";
import {
  initialPortfolio,
  type Fill,
} from "../packages/paper-trading/src/index.ts";

const HOUR = 3600000,
  NOW = Date.UTC(2026, 10, 13, 12);
const start = NOW - 6 * HOUR;
function fill(
  side: "BUY" | "SELL",
  timestamp: number,
  price: number,
  pnl: number | null,
  quantity = 2,
): Fill {
  return {
    orderId: `${timestamp}`,
    side,
    timestamp,
    price,
    pnl,
    quantity,
    fee: 0.1,
    slippage: 0,
    priceImpact: 0,
  };
}
const buy = fill("BUY", start + HOUR, 10, null);
const sell = fill("SELL", start + 3 * HOUR, 9, -2.2);
function model(
  points: ValuationPoint[],
  fills: Fill[],
  portfolio = initialPortfolio(NOW, 100),
) {
  return equityCurveModel(
    downsampleEquityCurve(
      attributeEquityHistory(points, fills, portfolio),
      NOW,
    ),
    "24h",
    NOW,
  )!;
}
const cash = {
  ...initialPortfolio(NOW, 100),
  usdc: 97.8,
  realized: -2.2,
  fees: 0.2,
};
const holding = {
  ...initialPortfolio(NOW, 100),
  usdc: 79.9,
  sui: 2,
  costBasis: 20.1,
  fees: 0.1,
};

describe("equity attribution from existing records", () => {
  it("has zero components with no trades", () => {
    const m = model(
      [
        { timestamp: start, equity: 100 },
        { timestamp: NOW, equity: 100 },
      ],
      [],
    );
    expect(m.breakdown).toEqual({ realized: 0, holding: 0 });
  });
  it("assigns a closed round trip and both fees to trading, matching monthly pnl", () => {
    const m = model(
      [
        { timestamp: start, equity: 100 },
        { timestamp: NOW, equity: 97.8 },
      ],
      [buy, sell],
      cash,
    );
    const report = buildMonthlyReport({
      monthKey: monthKeyOf(NOW),
      fills: [buy, sell],
      fillsWindowCapped: false,
      counters: undefined,
    });
    expect(m.breakdown?.realized).toBeCloseTo(report.pnlUsdc!);
    expect(m.breakdown?.realized).toBeCloseTo(-2.2);
    expect(m.breakdown?.holding).toBeCloseTo(0);
    expect(m.delta).toBeCloseTo(m.breakdown!.realized + m.breakdown!.holding);
  });
  it("keeps entry costs and the mark change on an open end position", () => {
    const m = model(
      [
        { timestamp: start, equity: 100 },
        { timestamp: NOW, equity: 97.9 },
      ],
      [buy],
      holding,
    );
    expect(m.breakdown).toEqual({ realized: 0, holding: -2.1 });
    expect(m.delta).toBeCloseTo(-2.1);
  });
  it("subtracts the opening unrealized pnl for a pre-period position", () => {
    const earlier = { ...buy, timestamp: start - HOUR };
    const m = model(
      [
        { timestamp: start, equity: 99.9 },
        { timestamp: NOW, equity: 97.8 },
      ],
      [earlier, sell],
      cash,
    );
    expect(m.breakdown?.realized).toBeCloseTo(-2.2);
    expect(m.breakdown?.holding).toBeCloseTo(0.1);
    expect(m.delta).toBeCloseTo(-2.1);
  });
  it("counts closes after the actual start point and through the actual end point only", () => {
    const m = model(
      [
        {
          timestamp: sell.timestamp,
          equity: 97.8,
          realized: -2.2,
          unrealized: 0,
        },
        { timestamp: NOW, equity: 97.8 },
      ],
      [buy, sell],
      cash,
    );
    expect(m.breakdown?.realized).toBeCloseTo(0);
    expect(m.breakdown?.holding).toBeCloseTo(0);
    expect(m.partialPeriod).toBe(true);
  });
  it("distinguishes pre-fill analysis and post-fill valuation at the same timestamp", () => {
    const attributed = attributeEquityHistory(
      [
        { timestamp: buy.timestamp, equity: 100 },
        {
          timestamp: buy.timestamp,
          equity: 99.9,
          realized: 0,
          unrealized: -0.1,
        },
        { timestamp: sell.timestamp, equity: 97.9 },
        {
          timestamp: sell.timestamp,
          equity: 97.8,
          realized: -2.2,
          unrealized: 0,
        },
      ],
      [buy, sell],
      cash,
    );
    expect(attributed.map((p) => p.attribution)).toEqual([
      { realized: 0, unrealized: 0 },
      { realized: 0, unrealized: -0.1 },
      { realized: 0, unrealized: -2.1 },
      { realized: -2.2, unrealized: 0 },
    ]);
  });
  it("does not invent an attribution for missing trade history", () => {
    const m = model(
      [
        { timestamp: start, equity: 100 },
        { timestamp: NOW, equity: 97.8 },
      ],
      [sell],
      cash,
    );
    expect(m.breakdown).toBeNull();
    expect(m.breakdownIssue).toBe("history");
  });
  it("uses allocated entry cost and exit fees for a partial close", () => {
    const partial = {
      ...sell,
      quantity: 1,
      pnl: -1.15,
      allocatedCostUsdc: "10.050000",
    };
    const portfolio = {
      ...holding,
      usdc: 88.8,
      sui: 1,
      costBasis: 10.05,
      realized: -1.15,
      fees: 0.2,
    };
    const m = model(
      [
        { timestamp: start, equity: 100 },
        { timestamp: NOW, equity: 97.8 },
      ],
      [buy, partial],
      portfolio,
    );
    expect(m.breakdown?.realized).toBeCloseTo(-1.15);
    expect(m.breakdown?.holding).toBeCloseTo(-1.05);
    expect(m.breakdown!.realized + m.breakdown!.holding).toBeCloseTo(m.delta);
  });
  it("withholds ambiguous multiple fills at a single valuation timestamp", () => {
    const attributed = attributeEquityHistory(
      [{ timestamp: buy.timestamp, equity: 100 }],
      [buy, { ...sell, timestamp: buy.timestamp }],
      cash,
    );
    expect(attributed[0].attribution).toEqual({ issue: "history" });
  });
  it("renders both values and an honest unavailable state", () => {
    const points = downsampleEquityCurve(
      attributeEquityHistory(
        [
          { timestamp: Date.now() - HOUR, equity: 100 },
          { timestamp: Date.now(), equity: 100 },
        ],
        [],
        initialPortfolio(NOW, 100),
      ),
      Date.now(),
    );
    const html = renderToStaticMarkup(createElement(EquityCurve, { points }));
    expect(html).toContain("取引（確定） 0.00 USDC");
    expect(html).toContain("保有中の値動き 0.00 USDC");
    const unavailable = renderToStaticMarkup(
      createElement(EquityCurve, {
        points: points.map((p) => ({
          ...p,
          attribution: { issue: "history" as const },
        })),
      }),
    );
    expect(unavailable).toContain(
      "取引記録が不足しているため、内訳を計算できません",
    );
    expect(unavailable).not.toContain("取引（確定） 0.00 USDC");
  });
  it("detects an inconsistent cash-only valuation rather than assigning it to holdings", () => {
    const m = model(
      [
        { timestamp: start, equity: 100 },
        { timestamp: NOW, equity: 97 },
      ],
      [buy, sell],
      cash,
    );
    expect(m.breakdown).toBeNull();
    expect(m.breakdownIssue).toBe("reconciliation");
  });
  it("detects a broken identity independently in the display model", () => {
    const m = equityCurveModel(
      [
        { t: start, equity: 100, attribution: { realized: 0, unrealized: 0 } },
        {
          t: NOW,
          equity: 97.8,
          attribution: { realized: -2.2, unrealized: 1 },
        },
      ],
      "24h",
      NOW,
    )!;
    expect(m.breakdown).toBeNull();
    expect(m.breakdownIssue).toBe("reconciliation");
  });
});
