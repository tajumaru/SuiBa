import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { Fill } from "../packages/paper-trading/src/index.ts";
import type { Candle } from "../packages/shared/src/index.ts";
import { analyseFills } from "../apps/dashboard/src/fillAnalysis.ts";
import { FillAnalysisCard } from "../apps/dashboard/src/FillAnalysisCard.tsx";

/** A JST wall-clock instant as epoch ms. */
function jst(y: number, m: number, d: number, h = 12, min = 0): number {
  return Date.UTC(y, m - 1, d, h, min) - 9 * 3600 * 1000;
}

function fill(overrides: Partial<Fill>): Fill {
  return {
    orderId: "o1",
    side: "BUY",
    timestamp: jst(2026, 11, 3, 7),
    quantity: 10,
    price: 0.9,
    fee: 0.01,
    pnl: null,
    slippage: 0,
    priceImpact: 0,
    ...overrides,
  };
}

/** Contiguous 5m candles (timestamps in seconds) whose closes
 * move one way, so the chart RSI saturates. */
function candles(trend: "down" | "up", count = 100): Candle[] {
  const startSec = Math.floor(jst(2026, 11, 1, 0) / 1000);
  return Array.from({ length: count }, (_, i) => {
    const close = trend === "down" ? 100 - i * 0.5 : 50 + i * 0.5;
    return {
      timestamp: startSec + i * 300,
      open: close,
      high: close + 0.1,
      low: close - 0.1,
      close,
      volume: 100,
      source: "test",
      timeframe: 300,
    } as Candle;
  });
}

describe("analyseFills attribution", () => {
  it("attributes a close to its opening buy's hour block", () => {
    const a = analyseFills(
      [
        fill({ side: "BUY", timestamp: jst(2026, 11, 3, 7) }),
        fill({
          side: "SELL",
          timestamp: jst(2026, 11, 3, 15),
          pnl: 0.5,
        }),
      ],
      [],
    );
    expect(a.closes).toBe(1);
    expect(a.unattributed).toBe(0);
    expect(a.byHour).toEqual([
      { label: "朝 6–12時", closes: 1, wins: 1, winRatePct: 100, pnlUsdc: 0.5 },
    ]);
    expect(a.rsiCovered).toBe(0);
    expect(a.byRsi).toEqual([]);
  });

  it("leaves a close whose buy is outside the window unattributed", () => {
    const a = analyseFills(
      [fill({ side: "SELL", timestamp: jst(2026, 11, 3, 15), pnl: 0.3 })],
      [],
    );
    expect(a.closes).toBe(0);
    expect(a.unattributed).toBe(1);
  });

  it("keeps the first opening buy as the entry for adds and partial closes", () => {
    const a = analyseFills(
      [
        fill({ side: "BUY", timestamp: jst(2026, 11, 3, 7), quantity: 10 }),
        fill({
          side: "SELL",
          timestamp: jst(2026, 11, 3, 9),
          quantity: 4,
          pnl: 0.2,
        }),
        fill({ side: "BUY", timestamp: jst(2026, 11, 3, 20), quantity: 5 }),
        fill({
          side: "SELL",
          timestamp: jst(2026, 11, 3, 21),
          quantity: 11,
          pnl: -0.1,
        }),
        fill({ side: "BUY", timestamp: jst(2026, 11, 3, 22), quantity: 10 }),
        fill({
          side: "SELL",
          timestamp: jst(2026, 11, 3, 23),
          quantity: 10,
          pnl: 0.4,
        }),
      ],
      [],
    );
    expect(a.closes).toBe(3);
    const morning = a.byHour.find((s) => s.label.startsWith("朝"));
    const night = a.byHour.find((s) => s.label.startsWith("夜"));
    expect(morning).toMatchObject({ closes: 2, wins: 1 });
    expect(morning?.pnlUsdc).toBeCloseTo(0.1);
    expect(night).toMatchObject({ closes: 1, wins: 1, pnlUsdc: 0.4 });
  });

  it("classifies night-owl buys into the 深夜 block", () => {
    const a = analyseFills(
      [
        fill({ side: "BUY", timestamp: jst(2026, 11, 3, 3) }),
        fill({ side: "SELL", timestamp: jst(2026, 11, 3, 4), pnl: -0.2 }),
      ],
      [],
    );
    expect(a.byHour[0]).toMatchObject({ label: "深夜 0–6時", wins: 0 });
  });
});

describe("analyseFills RSI reconstruction", () => {
  it("reads the entry RSI from the last candle closed before the buy", () => {
    const cs = candles("down");
    const lastCloseMs = (cs.at(-1)!.timestamp + 300) * 1000;
    const a = analyseFills(
      [
        fill({ side: "BUY", timestamp: lastCloseMs + 1000 }),
        fill({ side: "SELL", timestamp: lastCloseMs + 7200_000, pnl: 0.5 }),
      ],
      cs,
    );
    expect(a.rsiCovered).toBe(1);
    expect(a.byRsi).toEqual([
      { label: "35以下", closes: 1, wins: 1, winRatePct: 100, pnlUsdc: 0.5 },
    ]);
  });

  it("puts a saturated rising entry in the top band", () => {
    const cs = candles("up");
    const lastCloseMs = (cs.at(-1)!.timestamp + 300) * 1000;
    const a = analyseFills(
      [
        fill({ side: "BUY", timestamp: lastCloseMs + 1000 }),
        fill({ side: "SELL", timestamp: lastCloseMs + 7200_000, pnl: -0.1 }),
      ],
      cs,
    );
    expect(a.byRsi[0]?.label).toBe("55超");
  });

  it("cannot reconstruct a buy from before the candle window", () => {
    const cs = candles("down");
    const beforeMs = cs[0].timestamp * 1000 - 60_000;
    const a = analyseFills(
      [
        fill({ side: "BUY", timestamp: beforeMs }),
        fill({ side: "SELL", timestamp: beforeMs + 7200_000, pnl: 0.5 }),
      ],
      cs,
    );
    expect(a.closes).toBe(1);
    expect(a.rsiCovered).toBe(0);
  });
});

describe("FillAnalysisCard", () => {
  it("renders the slice tables for a round trip", () => {
    const html = renderToStaticMarkup(
      createElement(FillAnalysisCard, {
        trades: [
          fill({ side: "BUY", timestamp: jst(2026, 11, 3, 7) }),
          fill({ side: "SELL", timestamp: jst(2026, 11, 3, 15), pnl: 0.5 }),
        ],
        candles: [],
      }),
    );
    expect(html).toContain("条件別の成績");
    expect(html).toContain("朝 6–12時");
    expect(html).toContain("+0.50");
  });

  it("renders nothing without trades", () => {
    const html = renderToStaticMarkup(
      createElement(FillAnalysisCard, { trades: [], candles: [] }),
    );
    expect(html).toBe("");
  });
});
