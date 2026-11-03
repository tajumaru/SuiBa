import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { Fill } from "../packages/paper-trading/src/index.ts";
import type {
  CandidateAudit,
  OperationEvent,
} from "../packages/shared/src/operations.ts";
import {
  advanceNarration,
  emptyNarrationState,
  type NarrationState,
} from "../apps/dashboard/src/agentNarration.ts";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";
import {
  persistNarration,
  restoreNarration,
} from "../apps/dashboard/src/narrationStorage.ts";
import {
  buildMonthlyReport,
  monthKeyOf,
  monthRangeMs,
  monthlyReportText,
} from "../apps/dashboard/src/monthlyReport.ts";
import { emptyMonthlyCounters } from "../apps/dashboard/src/narration/state.ts";
import { MonthlyReportCard } from "../apps/dashboard/src/MonthlyReportCard.tsx";

/** A JST wall-clock instant as epoch ms. */
function jst(y: number, m: number, d: number, h = 12, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min) - 9 * 3600 * 1000;
}

function fill(overrides: Partial<Fill>): Fill {
  return {
    orderId: "o1",
    side: "SELL",
    timestamp: jst(2026, 10, 12),
    quantity: 10,
    price: 0.9,
    fee: 0.01,
    pnl: null,
    slippage: 0,
    priceImpact: 0,
    ...overrides,
  };
}

describe("JST month helpers", () => {
  it("keys months by JST, not UTC", () => {
    expect(monthKeyOf(jst(2026, 11, 1, 0, 30))).toBe("2026-11");
    expect(monthKeyOf(jst(2026, 10, 31, 23, 30))).toBe("2026-10");
  });
  it("ranges a JST calendar month", () => {
    const { start, end } = monthRangeMs("2026-11");
    expect(start).toBe(jst(2026, 11, 1, 0, 0));
    expect(end).toBe(jst(2026, 12, 1, 0, 0));
  });
});

describe("buildMonthlyReport", () => {
  const fills = [
    fill({ side: "BUY", timestamp: jst(2026, 10, 5), pnl: null }),
    fill({ side: "SELL", timestamp: jst(2026, 10, 12), pnl: 0.5 }),
    fill({ side: "SELL", timestamp: jst(2026, 10, 20), pnl: -0.2 }),
    fill({ side: "SELL", timestamp: jst(2026, 9, 30), pnl: 9 }),
  ];
  it("aggregates the month's money from fills", () => {
    const r = buildMonthlyReport({
      monthKey: "2026-10",
      fills,
      fillsWindowCapped: false,
      counters: undefined,
    });
    expect(r.fillsTotal).toBe(3);
    expect(r.fillsBuy).toBe(1);
    expect(r.closed).toBe(2);
    expect(r.winRatePct).toBe(50);
    expect(r.pnlUsdc).toBeCloseTo(0.3);
    expect(r.best?.pnl).toBe(0.5);
    expect(r.worst?.pnl).toBe(-0.2);
  });
  it("reports no money figures when the window may not cover the month", () => {
    const r = buildMonthlyReport({
      monthKey: "2026-10",
      fills: fills.slice(1, 3), // oldest is Oct 12, window capped
      fillsWindowCapped: true,
      counters: undefined,
    });
    expect(r.pnlUsdc).toBeNull();
    expect(r.winRatePct).toBeNull();
    expect(r.best).toBeNull();
    expect(monthlyReportText(r)).toContain("記録の範囲外");
  });
  it("prefers the feed's fill tallies and breaks stops down by reason", () => {
    const counters = {
      ...emptyMonthlyCounters(),
      declared: 9,
      hits: 3,
      misses: 4,
      nearMisses: 5,
      stops: 4,
      stopReasons: { THIN_ORDERBOOK: 2, MARKET_DATA_STALLED: 1, WHATEVER: 1 },
      fillsBuy: 4,
      fillsSell: 2,
    };
    const r = buildMonthlyReport({
      monthKey: "2026-10",
      fills,
      fillsWindowCapped: false,
      counters,
    });
    expect(r.fillsTotal).toBe(6);
    expect(r.stopBreakdown).toEqual([
      ["板不足", 2],
      ["市場データ停止", 1],
      ["その他", 1],
    ]);
    const text = monthlyReportText(r);
    expect(text).toContain("10月の月報");
    expect(text).toContain("停止は4回");
    expect(r.comment).toContain("4回止まった");
  });
});

function ops(
  overrides: Partial<OperationsSnapshot> & Record<string, unknown>,
): OperationsSnapshot {
  return {
    status: "STOPPED",
    events: [],
    candidates: [],
    decision: null,
    safety: null,
    stopReason: null,
    ...overrides,
  } as unknown as OperationsSnapshot;
}

const OCT_COUNTERS = {
  ...emptyMonthlyCounters(),
  declared: 5,
  hits: 2,
  misses: 2,
  nearMisses: 1,
  stops: 1,
  stopReasons: { MARKET_DATA_STALLED: 1 },
  fillsBuy: 1,
  fillsSell: 1,
};

describe("advanceNarration monthly tallies", () => {
  it("counts non-manual STOP events by month and reason", () => {
    const prev: NarrationState = { ...emptyNarrationState(), initialized: true };
    const at = jst(2026, 11, 3, 10);
    const events = [
      { timestamp: at, kind: "STOP", code: "THIN_ORDERBOOK" },
      { timestamp: at + 1, kind: "STOP", code: "MANUAL_STOP" },
    ] as unknown as OperationEvent[];
    const next = advanceNarration(prev, ops({ events }), "sleeping", at + 2);
    const counters = next.monthly["2026-11"];
    expect(counters?.stops).toBe(1);
    expect(counters?.stopReasons).toEqual({ THIN_ORDERBOOK: 1 });
    // Re-advancing the same snapshot counts nothing twice.
    const again = advanceNarration(next, ops({ events }), "sleeping", at + 3);
    expect(again.monthly["2026-11"]?.stops).toBe(1);
  });

  it("counts a recorded fill candidate in its month", () => {
    const prev: NarrationState = { ...emptyNarrationState(), initialized: true };
    const at = jst(2026, 11, 3, 10);
    const candidate = {
      id: "cand-1",
      orderId: "ord-1",
      timestamp: at,
      createdAt: at,
      side: "BUY",
      requestedInputAtomic: "5000000",
      quantityAtomic: "5500000",
      quotePriceUsdc: "0.9",
      quoteExpiresAt: null,
      acquisitionCostUsdc: null,
      expectedSaleUsdc: null,
      saleModel: null,
      dexFeeUsdc: null,
      gasUsdc: null,
      additionalFeeUsdc: null,
      buyGasUsdc: null,
      netProfitUsdc: null,
      minProfitUsdc: "0",
      minProfitPct: "0",
      finalAction: "BUY",
      status: "COMMITTED",
      reasons: [],
    } as unknown as CandidateAudit;
    const next = advanceNarration(
      prev,
      ops({ candidates: [candidate] }),
      "alive",
      at + 1,
    );
    expect(next.monthly["2026-11"]?.fillsBuy).toBe(1);
    expect(next.monthly["2026-11"]?.fillsSell).toBe(0);
  });
});

describe("monthly finalisation", () => {
  const prevWithOctober: NarrationState = {
    ...emptyNarrationState(),
    initialized: true,
    monthly: { "2026-10": OCT_COUNTERS },
  };
  const fills = [
    fill({ side: "BUY", timestamp: jst(2026, 10, 5), pnl: null }),
    fill({ side: "SELL", timestamp: jst(2026, 10, 12), pnl: 0.5 }),
  ];
  const NOV_15 = jst(2026, 11, 15);
  it("posts the finished month once, with its figures", () => {
    const next = advanceNarration(prevWithOctober, ops({}), "sleeping", NOV_15, fills);
    const entries = next.entries.filter((e) => e.kind === "monthlyReport");
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain("10月の月報");
    expect(entries[0].text).toContain("約定2件");
    expect(next.monthlyFinalised).toBe("2026-10");
    const again = advanceNarration(next, ops({}), "sleeping", NOV_15 + 1000, fills);
    expect(
      again.entries.filter((e) => e.kind === "monthlyReport"),
    ).toHaveLength(1);
  });
  it("waits for the fills before posting", () => {
    const next = advanceNarration(prevWithOctober, ops({}), "sleeping", NOV_15);
    expect(next.entries.some((e) => e.kind === "monthlyReport")).toBe(false);
    expect(next.monthlyFinalised).toBeNull();
  });
  it("never posts the current month", () => {
    const state: NarrationState = {
      ...emptyNarrationState(),
      initialized: true,
      monthly: { "2026-11": OCT_COUNTERS },
    };
    const next = advanceNarration(state, ops({}), "sleeping", NOV_15, fills);
    expect(next.entries.some((e) => e.kind === "monthlyReport")).toBe(false);
  });
});

describe("narration storage monthly fields", () => {
  function fakeStorage() {
    let value: string | null = null;
    return {
      getItem: () => value,
      setItem: (_k: string, v: string) => {
        value = v;
      },
      read: () => value,
    };
  }
  it("round-trips the monthly counters", () => {
    const storage = fakeStorage();
    const state: NarrationState = {
      ...emptyNarrationState(),
      monthly: { "2026-10": OCT_COUNTERS },
      monthlyFinalised: "2026-10",
    };
    persistNarration(state, storage);
    const restored = restoreNarration(storage);
    expect(restored.monthly["2026-10"]?.hits).toBe(2);
    expect(restored.monthlyFinalised).toBe("2026-10");
  });
  it("loads a pre-monthly-report save with defaults, keeping its entries", () => {
    const storage = fakeStorage();
    const old = JSON.parse(
      JSON.stringify({
        ...emptyNarrationState(),
        entries: [
          {
            id: "narration:0",
            at: 1,
            kind: "status",
            text: "昔の記録",
          },
        ],
      }),
    ) as Record<string, unknown>;
    delete old.monthly;
    delete old.monthlyFinalised;
    storage.setItem("k", JSON.stringify(old));
    const restored = restoreNarration(storage);
    expect(restored.monthly).toEqual({});
    expect(restored.monthlyFinalised).toBeNull();
    expect(restored.entries).toHaveLength(1);
  });
});

describe("MonthlyReportCard", () => {
  it("renders the current month's fills from the engine records", () => {
    const { start } = monthRangeMs(monthKeyOf(Date.now()));
    const trades = [
      fill({ side: "BUY", timestamp: start + 1000, pnl: null }),
      fill({ side: "SELL", timestamp: start + 2000, pnl: 0.5 }),
    ];
    const html = renderToStaticMarkup(
      createElement(MonthlyReportCard, {
        pair: "SUI_USDC",
        trades,
        orders: [],
      }),
    );
    expect(html).toContain("月報");
    expect(html).toContain("2件（買い1・売り1）");
    expect(html).toContain("100%（1/1）");
    expect(html).toContain("+0.50 USDC");
    expect(html).toContain("今月");
    expect(html).toContain("先月");
  });
});
