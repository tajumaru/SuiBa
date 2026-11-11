import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaults, type Settings } from "../packages/shared/src/index.ts";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import {
  DailyBudgetCard,
  DailyBudgetStrip,
  dailyBudgetView,
} from "../apps/dashboard/src/DailyBudget.tsx";
import { OverviewTab } from "../apps/dashboard/src/OverviewTab.tsx";
import type { SettingsApi } from "../apps/dashboard/src/settingsPresets.ts";

type State = ReturnType<BotEngine["snapshot"]>;

function data(
  overrides: {
    settings?: Partial<Settings>;
    dailyBought?: number;
    dayStartEquity?: number;
    sui?: number;
    dailyPnl?: number | null;
    price?: number | null;
    equity?: number | null;
    running?: boolean;
    emergency?: boolean;
    error?: string | null;
  } = {},
): State {
  const price = overrides.price === undefined ? 1 : overrides.price;
  return {
    settings: { ...defaults, ...(overrides.settings ?? {}) },
    portfolio: {
      sui: overrides.sui ?? 0,
      usdc: 100,
      costBasis: 0,
      realized: 0,
      fees: 0,
      initialEquity: 100,
      day: "2026-11-11",
      dayStartEquity: overrides.dayStartEquity ?? 100,
      dailyBought: overrides.dailyBought ?? 0,
    },
    dailyPnl: overrides.dailyPnl === undefined ? 0 : overrides.dailyPnl,
    price,
    equity: overrides.equity === undefined ? 100 : overrides.equity,
    runtime: {
      running: overrides.running ?? true,
      emergency: overrides.emergency ?? false,
      error: overrides.error ?? null,
      lastCandle: null,
    },
  } as unknown as State;
}

const render = (state: State) =>
  renderToStaticMarkup(<DailyBudgetCard data={state} />);

describe("今日の残り (daily budget view)", () => {
  it("shows the remaining budget and buy count when a buy can still go through", () => {
    // Mirrors the first production day: one 5 USDC buy stopped
    // out for -0.1377 USDC against a 1% daily loss cap.
    const state = data({ dailyBought: 5, dailyPnl: -0.1377 });
    const view = dailyBudgetView(state);
    expect(view.remainingUsdc).toBe(15);
    expect(view.moreBuys).toBe(3);
    expect(view.lossCapUsdc).toBe(1);
    expect(view.lossHeadroomUsdc).toBeCloseTo(0.8623);
    expect(view.verdict).toBe("買える（シグナル待ち）");
    const html = render(state);
    expect(html).toContain("今日の残り");
    expect(html).toContain("今日の購入：5 / 20 USDC（あと 15 USDC・最大あと 3 回）");
    expect(html).toContain(
      "日次損失：-0.1377 USDC（損失上限 −1 USDC まであと 0.8623 USDC）",
    );
    expect(html).toContain("購入可否：買える（シグナル待ち）");
  });

  it("reports the buy limit once the daily budget is spent", () => {
    const state = data({ dailyBought: 20 });
    const view = dailyBudgetView(state);
    expect(view.remainingUsdc).toBe(0);
    expect(view.moreBuys).toBe(0);
    expect(view.verdict).toBe("購入上限に到達");
    expect(render(state)).toContain("購入可否：購入上限に到達");
  });

  it("reports the buy limit when the remainder fits no full-size order", () => {
    // Orders are placed at maxOrder with no clamping, so 3 USDC
    // left under a 5 USDC order size means no further buy passes.
    const view = dailyBudgetView(data({ dailyBought: 17 }));
    expect(view.remainingUsdc).toBe(3);
    expect(view.moreBuys).toBe(0);
    expect(view.verdict).toBe("購入上限に到達");
  });

  it("reports the daily loss cap once equity reaches the floor", () => {
    const state = data({ dailyPnl: -1.2 });
    const view = dailyBudgetView(state);
    expect(view.lossHeadroomUsdc).toBeCloseTo(-0.2);
    expect(view.verdict).toBe("日次損失上限に到達");
    expect(render(state)).toContain("購入可否：日次損失上限に到達");
  });

  it("reports the holding cap when the position already sits at it", () => {
    const view = dailyBudgetView(data({ sui: 30, price: 1, equity: 100 }));
    expect(view.verdict).toBe("保有比率の上限");
  });

  it("reports stopped before any limit while the bot is not running", () => {
    expect(dailyBudgetView(data({ running: false })).verdict).toBe(
      "停止中・運用外",
    );
    expect(
      dailyBudgetView(data({ running: false, dailyBought: 20 })).verdict,
    ).toBe("停止中・運用外");
    expect(dailyBudgetView(data({ emergency: true })).verdict).toBe(
      "停止中・運用外",
    );
    expect(dailyBudgetView(data({ error: "PAPER_STOPPED" })).verdict).toBe(
      "停止中・運用外",
    );
  });

  it("counts orders against the raised 10 USDC size", () => {
    const view = dailyBudgetView(
      data({ settings: { maxOrder: 10 }, dailyBought: 10 }),
    );
    expect(view.remainingUsdc).toBe(10);
    expect(view.moreBuys).toBe(1);
    expect(view.verdict).toBe("買える（シグナル待ち）");
  });
});

describe("概要の購入残りストリップ (overview budget strip)", () => {
  const renderStrip = (state: State) =>
    renderToStaticMarkup(<DailyBudgetStrip data={state} />);

  it("headlines the remaining buy count, USDC and status", () => {
    // Same first-day values as the card: used 5 of 20 USDC at a
    // 5 USDC order size leaves 15 USDC, i.e. 3 more buys.
    const html = renderStrip(data({ dailyBought: 5, dailyPnl: -0.1377 }));
    expect(html).toContain("今日の購入 あと");
    expect(html).toContain(">3</strong>");
    expect(html).toContain("残り 15 USDC ・ 買える（シグナル待ち）");
  });

  it("shows zero and the blocker once the daily budget is spent", () => {
    const html = renderStrip(data({ dailyBought: 20 }));
    expect(html).toContain(">0</strong>");
    expect(html).toContain("残り 0 USDC ・ 購入上限に到達");
  });

  it("shows the stopped status before any limit", () => {
    const html = renderStrip(data({ running: false }));
    expect(html).toContain("停止中・運用外");
  });

  it("shows a dash instead of a number when the count is unknown", () => {
    const state = data({});
    (state.portfolio as { dailyBought: unknown }).dailyBought = null;
    const html = renderStrip(state);
    expect(dailyBudgetView(state).moreBuys).toBeNull();
    expect(html).toContain(">—</strong>");
    expect(html).toContain("残り — USDC");
  });

  it("appears on the overview tab under the asset cards", () => {
    const state = {
      ...data({ dailyBought: 5, dailyPnl: -0.1377 }),
      pair: "SUI_USDC",
      pnl: 0,
      todayTrades: 1,
      unrealized: 0,
      metrics: {},
      equityCurve: [],
      orders: [],
      trades: [],
      weather: null,
      candlesByTimeframe: { 300: [], 900: [], 3600: [] },
      longTermDaily: [],
      bookImbalance: null,
    } as unknown as State;
    const html = renderToStaticMarkup(
      <OverviewTab
        data={state}
        timeframe={300}
        setTimeframe={() => {}}
        api={null as unknown as SettingsApi}
        forecastScoreLine={null}
        forecastTouchLine={null}
        forecastBandScale={1}
        forecastAnswer={null}
        shareCard={null}
        sellLines={null}
      />,
    );
    expect(html).toContain("budget-strip");
    expect(html).toContain("今日の購入 あと");
    expect(html).toContain(">3</strong>");
    expect(html).toContain("残り 15 USDC ・ 買える（シグナル待ち）");
    // The strip sits in the summary zone: after the asset cards,
    // before the portfolio mix.
    expect(html.indexOf("budget-strip")).toBeGreaterThan(
      html.indexOf("本日の取引"),
    );
    expect(html.indexOf("budget-strip")).toBeLessThan(
      html.indexOf("portfolio-mix"),
    );
  });
});
