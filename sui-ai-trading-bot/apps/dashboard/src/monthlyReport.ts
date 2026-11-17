import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import type { MonthlyCounters } from "./narration/state.ts";
import { emptyMonthlyCounters } from "./narration/state.ts";

/**
 * The monthly report （月報）: one JST calendar month of the
 * bot's accumulated record, aggregated from two honest sources
 * — the engine's fills (money: counts, win rate, PnL, best and
 * worst close) and the narration feed's own monthly counters
 * (watches, near misses, stops — things only the feed
 * witnesses, counted at the same moments they happen).
 *
 * The engine snapshot carries only the newest 200 fills, so a
 * month the window no longer covers reports its money side as
 * uncountable instead of quietly wrong.
 */

const JST_OFFSET_MS = 9 * 3600 * 1000;
const monthKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
});

/** "2026-11" for a timestamp, in JST. */
export function monthKeyOf(ms: number): string {
  return monthKeyFormat.format(new Date(ms));
}

/** [start, end) of a JST calendar month, as epoch ms. */
export function monthRangeMs(monthKey: string): {
  start: number;
  end: number;
} {
  const [y, m] = monthKey.split("-").map(Number);
  return {
    start: Date.UTC(y, m - 1, 1) - JST_OFFSET_MS,
    end: Date.UTC(y, m, 1) - JST_OFFSET_MS,
  };
}

/** "11月" for a month key. */
export function monthLabelOf(monthKey: string): string {
  return `${Number(monthKey.split("-")[1])}月`;
}

const dayFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
});

/** Short labels for the stop-reason breakdown. */
export const STOP_REASON_SHORT: Record<string, string> = {
  MARKET_DATA_STALLED: "市場データ停止",
  THIN_ORDERBOOK: "板不足",
  STALE_ORDERBOOK: "板が古い",
  SPREAD_TOO_WIDE: "スプレッド過大",
  PROCESS_SHUTDOWN: "プロセス終了",
  PROCESS_RESTART_STOPPED: "再起動",
  PROCESS_RESTART_INTERRUPTED: "再起動で中断",
  EMERGENCY_STOP: "緊急停止",
  UPSTREAM_HTTP_429: "レート制限",
  DATA_OR_EXECUTION_FAILURE: "実行エラー",
};

export interface MonthlyReport {
  monthKey: string;
  monthLabel: string;
  fillsTotal: number;
  fillsBuy: number;
  fillsSell: number;
  closed: number;
  /** Closed round trips in the month, or null when the fills
   * window does not verifiably cover the whole month. */
  roundTrips: number | null;
  wins: number;
  /** 0..100, or null when nothing closed that month. */
  winRatePct: number | null;
  /** Realised PnL for the month, or null when the fills
   * window does not verifiably cover the whole month. */
  pnlUsdc: number | null;
  best: { pnl: number; at: number } | null;
  worst: { pnl: number; at: number } | null;
  declared: number;
  hits: number;
  misses: number;
  nearMisses: number;
  stops: number;
  /** [short label, count], most frequent first. */
  stopBreakdown: [string, number][];
  /** The character's one look back, built only from the
   * facts above (same discipline as the sleep talk). */
  comment: string;
}

function fmtUsdc(v: number): string {
  const s = Math.abs(v).toFixed(2);
  return v > 0 ? `+${s}` : v < 0 ? `-${s}` : "0";
}

export function buildMonthlyReport(input: {
  monthKey: string;
  fills: readonly Fill[];
  /** True when the fills list was cut at the snapshot cap, so
   * old months may be missing their early fills. */
  fillsWindowCapped: boolean;
  counters: MonthlyCounters | undefined;
}): MonthlyReport {
  const { monthKey, fillsWindowCapped } = input;
  const counters = input.counters ?? emptyMonthlyCounters();
  const { start, end } = monthRangeMs(monthKey);
  const monthFills = input.fills.filter(
    (f) => f.timestamp >= start && f.timestamp < end,
  );
  const oldest = input.fills.reduce(
    (a, f) => Math.min(a, f.timestamp),
    Number.POSITIVE_INFINITY,
  );
  const moneyCovered = !fillsWindowCapped || oldest <= start;
  const closedFills = monthFills.filter((f) => f.pnl != null);
  const closed = closedFills.length;
  const wins = closedFills.filter((f) => (f.pnl ?? 0) > 0).length;
  // Every money figure is gated on the window verifiably
  // covering the month; a partial window reports none of them
  // rather than a quietly wrong subset.
  const pnlUsdc =
    moneyCovered && closed > 0
      ? closedFills.reduce((a, f) => a + (f.pnl ?? 0), 0)
      : null;
  const bestFill = moneyCovered
    ? closedFills.reduce<Fill | null>(
        (a, f) => (a == null || (f.pnl ?? 0) > (a.pnl ?? 0) ? f : a),
        null,
      )
    : null;
  const worstFill = moneyCovered
    ? closedFills.reduce<Fill | null>(
        (a, f) => (a == null || (f.pnl ?? 0) < (a.pnl ?? 0) ? f : a),
        null,
      )
    : null;
  // Fill counts prefer the feed's own tallies when it recorded
  // any: they are counted as the fills happen and never fall
  // out of a window.
  const countedFills = counters.fillsBuy + counters.fillsSell;
  const stopBreakdown = Object.entries(counters.stopReasons)
    .map(
      ([code, n]) =>
        [STOP_REASON_SHORT[code] ?? "その他", n] as [string, number],
    )
    .sort((a, b) => b[1] - a[1]);
  const report: MonthlyReport = {
    monthKey,
    monthLabel: monthLabelOf(monthKey),
    fillsTotal: countedFills > 0 ? countedFills : monthFills.length,
    fillsBuy:
      countedFills > 0
        ? counters.fillsBuy
        : monthFills.filter((f) => f.side === "BUY").length,
    fillsSell:
      countedFills > 0
        ? counters.fillsSell
        : monthFills.filter((f) => f.side === "SELL").length,
    closed,
    roundTrips: moneyCovered ? closed : null,
    wins,
    winRatePct:
      moneyCovered && closed > 0 ? Math.round((wins / closed) * 100) : null,
    pnlUsdc,
    best:
      bestFill && (bestFill.pnl ?? 0) > 0
        ? { pnl: bestFill.pnl ?? 0, at: bestFill.timestamp }
        : null,
    worst:
      worstFill && (worstFill.pnl ?? 0) < 0
        ? { pnl: worstFill.pnl ?? 0, at: worstFill.timestamp }
        : null,
    declared: counters.declared,
    hits: counters.hits,
    misses: counters.misses,
    nearMisses: counters.nearMisses,
    stops: counters.stops,
    stopBreakdown,
    comment: "",
  };
  report.comment = monthlyComment(report);
  return report;
}

export function monthlyComment(r: MonthlyReport): string {
  if (r.fillsTotal === 0 && r.declared === 0 && r.stops === 0)
    return "約定も注目もない、静かな月だった。";
  if (r.stops >= 3) {
    const top = r.stopBreakdown[0]?.[0];
    return `今月は${r.stops}回止まった。${top ? `いちばん多かったのは${top}。` : ""}無理に動かない判断はできていたと思う。`;
  }
  if (r.pnlUsdc != null && r.pnlUsdc > 0)
    return `損益はプラスで終えた。${r.best ? `一番の勝ちは${dayFormat.format(r.best.at)}の${fmtUsdc(r.best.pnl)}。` : ""}${r.hits >= 2 ? `的中も${r.hits}回あった。` : ""}`;
  if (r.pnlUsdc != null && r.pnlUsdc < 0)
    return `損益はマイナスで終えた。${r.worst ? `一番の負けは${dayFormat.format(r.worst.at)}の${fmtUsdc(r.worst.pnl)}。` : ""}来月はここを取り返したい。`;
  if (r.hits >= 2 && r.hits > r.misses)
    return `注目は的中${r.hits}回、外れ${r.misses}回。当てる側に寄った月だった。`;
  if (r.fillsTotal === 0)
    return `約定はなかった。注目は宣言${r.declared}回、的中${r.hits}回。静かに相場を見ていた月だった。`;
  return `約定${r.fillsTotal}件、的中${r.hits}回。記録を淡々と積んだ月だった。`;
}

/** The feed entry text for a finished month. */
export function monthlyReportText(r: MonthlyReport): string {
  const money =
    r.pnlUsdc != null
      ? `月間損益は${fmtUsdc(r.pnlUsdc)} USDC、勝率${r.winRatePct}%`
      : r.closed === 0
        ? "決済はまだない"
        : "損益は記録の範囲外で集計できない";
  const stops =
    r.stops > 0
      ? `停止は${r.stops}回（${r.stopBreakdown.map(([label, n]) => `${label}×${n}`).join("・")}）`
      : "停止はなし";
  return `${r.monthLabel}の月報だよ。約定${r.fillsTotal}件（買い${r.fillsBuy}・売り${r.fillsSell}）、${money}。注目は宣言${r.declared}・的中${r.hits}・外れ${r.misses}、ニアミス${r.nearMisses}回。${stops}。${r.comment}`;
}

export { fmtUsdc as formatMonthlyUsdc, dayFormat as monthlyDayFormat };
