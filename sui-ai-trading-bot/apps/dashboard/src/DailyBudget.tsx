import React from "react";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import { number } from "./presentation.ts";

type State = BotSnapshot;

const finite = (v: number | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * What is left of today's limits, derived only from the snapshot
 * the dashboard already receives: the portfolio's daily counters
 * (dailyBought, dayStartEquity), the mark-to-market daily PnL the
 * snapshot computes, the current position, and the runtime state.
 * Nothing here feeds back into enforcement — it reports the same
 * quantities the risk engine checks (daily buy total against the
 * daily limit, equity against the day-start loss floor, holding
 * value against the ratio cap), so the owner can see how many
 * more buys fit today and what would block the next one.
 */
export interface DailyBudgetView {
  usedUsdc: number | null;
  buyLimitUsdc: number;
  remainingUsdc: number | null;
  /** Full-size orders that still fit: orders are placed at the
   * maxOrder size with no clamping, so a remainder smaller than
   * one order means no further buy can pass the daily limit. */
  moreBuys: number | null;
  dailyPnlUsdc: number | null;
  lossCapUsdc: number | null;
  /** How far equity can still fall before the daily loss floor
   * blocks new buys (negative once the floor is reached). */
  lossHeadroomUsdc: number | null;
  verdict: string;
}

export function dailyBudgetView(data: State): DailyBudgetView {
  const s = data.settings,
    p = data.portfolio;
  const used = finite(p?.dailyBought),
    remaining = used == null ? null : Math.max(0, s.dailyBuyLimit - used),
    moreBuys =
      remaining == null
        ? null
        : Math.max(0, Math.floor((remaining + 1e-9) / s.maxOrder)),
    pnl = finite(data.dailyPnl),
    dayStart = finite(p?.dayStartEquity),
    lossCap = dayStart == null ? null : dayStart * s.dailyLossPct,
    headroom = pnl == null || lossCap == null ? null : pnl + lossCap,
    price = finite(data.price),
    equity = finite(data.equity),
    holding =
      price == null || equity == null || equity <= 0
        ? null
        : (p.sui * price) / equity,
    r = data.runtime;
  // Blockers are reported in stop-first order and only when the
  // snapshot actually supports them: a stopped bot cannot buy at
  // all; the loss floor mirrors the risk engine's equity check;
  // the buy limit is exhausted once no full-size order fits; the
  // holding cap is claimed only when the position already sits
  // at or over it (a buy can only raise the ratio from there).
  const verdict =
    !r.running || r.emergency || r.error != null
      ? "停止中・運用外"
      : headroom != null && headroom <= 0
        ? "日次損失上限に到達"
        : moreBuys != null && moreBuys <= 0
          ? "購入上限に到達"
          : holding != null && holding >= s.maxHoldingRatio
            ? "保有比率の上限"
            : "買える（シグナル待ち）";
  return {
    usedUsdc: used,
    buyLimitUsdc: s.dailyBuyLimit,
    remainingUsdc: remaining,
    moreBuys,
    dailyPnlUsdc: pnl,
    lossCapUsdc: lossCap,
    lossHeadroomUsdc: headroom,
    verdict,
  };
}

/**
 * The 今日の残り card on the strategy tab's settings segment,
 * rendered with the saved-settings summary: today's consumption
 * of the buy budget and the loss cap, and whether a buy could
 * still go through. Display only — limits stay enforced by the
 * worker exactly as before.
 */
export function DailyBudgetCard({ data }: { data: State }) {
  const v = dailyBudgetView(data);
  return (
    <div className="daily-budget" aria-label="今日の残り">
      <h3>今日の残り</h3>
      <p>
        今日の購入：{number(v.usedUsdc, 4)} / {number(v.buyLimitUsdc, 4)}{" "}
        USDC（あと {number(v.remainingUsdc, 4)} USDC・最大あと{" "}
        {v.moreBuys ?? "—"} 回）
      </p>
      <p>
        日次損失：{number(v.dailyPnlUsdc, 4)} USDC（損失上限 −
        {number(v.lossCapUsdc, 4)} USDC まであと{" "}
        {number(v.lossHeadroomUsdc, 4)} USDC）
      </p>
      <p>購入可否：{v.verdict}</p>
    </div>
  );
}

/**
 * The compact budget strip on the overview tab, directly under
 * the asset cards: the same 今日の残り view model reduced to its
 * headline — how many more full-size buys fit today, the USDC
 * left, and what would block the next buy — so the number is
 * visible without opening the strategy tab. Display only.
 */
export function DailyBudgetStrip({ data }: { data: State }) {
  const v = dailyBudgetView(data);
  return (
    <section className="budget-strip" aria-label="今日の購入残り">
      <p className="budget-strip-line">
        <span className="budget-strip-label">今日の購入 あと</span>
        <strong className="budget-strip-count">{v.moreBuys ?? "—"}</strong>
        <span className="budget-strip-unit">回</span>
        <span className="budget-strip-meta">
          残り {number(v.remainingUsdc, 4)} USDC ・ {v.verdict}
        </span>
      </p>
    </section>
  );
}
