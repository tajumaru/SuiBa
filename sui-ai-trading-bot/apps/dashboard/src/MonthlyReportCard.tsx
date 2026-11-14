import { useMemo, useState } from "react";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import { activityStreaks, buildActivityWeeks } from "./ActivityGrass.tsx";
import { highlightLabel, loadHighlights } from "./highlightStore.ts";
import {
  buildMonthlyReport,
  formatMonthlyUsdc,
  monthKeyOf,
  monthRangeMs,
  monthlyDayFormat,
} from "./monthlyReport.ts";
import { restoreNarration } from "./narrationStorage.ts";
import type { Highlight } from "./highlightStore.ts";

/**
 * The monthly report card on the Overview tab, under the
 * activity grass: the current month growing live, the previous
 * month final. Money comes from the engine's fills, watches
 * and stops from the narration feed's monthly counters — the
 * same tallies the feed posts as a 月報 entry when a month
 * closes. Months before the counters existed show their money
 * side only, and say so.
 */

const HIGHLIGHT_RANK: Record<string, number> = {
  trade: 0,
  watchHit: 1,
  priceLineReached: 2,
  sellLine: 3,
  nearMiss: 4,
  epoch: 5,
};

function bestHighlight(
  highlights: readonly Highlight[],
  start: number,
  end: number,
): Highlight | null {
  let best: Highlight | null = null;
  for (const h of highlights) {
    if (h.at < start || h.at >= end) continue;
    if (
      best == null ||
      (HIGHLIGHT_RANK[h.kind] ?? 9) < (HIGHLIGHT_RANK[best.kind] ?? 9) ||
      ((HIGHLIGHT_RANK[h.kind] ?? 9) === (HIGHLIGHT_RANK[best.kind] ?? 9) &&
        h.at > best.at)
    )
      best = h;
  }
  return best;
}

export function MonthlyReportCard({
  pair,
  trades,
  orders,
  cumulativeRoundTrips,
}: {
  pair: string;
  trades: readonly Fill[];
  orders: Record<string, unknown>[];
  cumulativeRoundTrips?: number;
}) {
  const scope = pair === "WAL_USDC" ? "WAL" : "SUI";
  const [view, setView] = useState<"current" | "prev">("current");
  const now = Date.now();
  const currentKey = monthKeyOf(now);
  const prevKey = monthKeyOf(monthRangeMs(currentKey).start - 1);
  const monthKey = view === "current" ? currentKey : prevKey;
  const data = useMemo(() => {
    const { start, end } = monthRangeMs(monthKey);
    const counters = restoreNarration(undefined, scope).monthly[monthKey];
    const report = buildMonthlyReport({
      monthKey,
      fills: trades,
      fillsWindowCapped: trades.length >= 200,
      counters,
    });
    const streaks = activityStreaks(
      buildActivityWeeks(
        orders,
        view === "current" ? Date.now() : end - 1,
        30,
      ),
    );
    const best = bestHighlight(loadHighlights(scope), start, end);
    return { counters, report, streaks, best };
  }, [scope, monthKey, trades, orders, view]);
  const { counters, report, streaks, best } = data;
  const hasAnything =
    report.fillsTotal > 0 || report.declared > 0 || report.stops > 0;
  return (
    <section className="monthly-report" aria-label="月報">
      <div className="monthly-report-head">
        <h3>
          {report.monthLabel}の月報
          {view === "current" ? "（進行中）" : ""}
        </h3>
        <div className="monthly-report-toggle" role="group" aria-label="月報の月">
          <button
            aria-pressed={view === "current"}
            onClick={() => setView("current")}
          >
            今月
          </button>
          <button
            aria-pressed={view === "prev"}
            onClick={() => setView("prev")}
          >
            先月
          </button>
        </div>
      </div>
      {!hasAnything ? (
        <p className="monthly-report-empty">この月の記録はまだない。</p>
      ) : (
        <>
          <dl className="monthly-report-rows">
            <div>
              <dt>約定</dt>
              <dd>
                {report.fillsTotal}件（買い{report.fillsBuy}・売り
                {report.fillsSell}）
              </dd>
            </div>
            <div>
              <dt>勝率</dt>
              <dd>
                {report.winRatePct != null
                  ? `${report.winRatePct}%（${report.wins}/${report.closed}）`
                  : "―"}
              </dd>
            </div>
            <div>
              <dt>往復</dt>
              <dd>
                {view === "current" ? "今月" : "先月"}{" "}
                {report.roundTrips != null
                  ? `${report.roundTrips}件`
                  : "集計できない（記録は直近200件まで）"}
                （累計
                {cumulativeRoundTrips != null
                  ? `${cumulativeRoundTrips}件`
                  : "集計できない"}
                ）
              </dd>
            </div>
            <div>
              <dt>月間損益</dt>
              <dd
                className={
                  report.pnlUsdc == null
                    ? undefined
                    : report.pnlUsdc >= 0
                      ? "pos"
                      : "neg"
                }
              >
                {report.pnlUsdc != null
                  ? `${formatMonthlyUsdc(report.pnlUsdc)} USDC`
                  : report.closed > 0
                    ? "集計できない（記録は直近200件まで）"
                    : "―"}
              </dd>
            </div>
            {report.best && (
              <div>
                <dt>一番の勝ち</dt>
                <dd className="pos">
                  {formatMonthlyUsdc(report.best.pnl)}（
                  {monthlyDayFormat.format(report.best.at)}）
                </dd>
              </div>
            )}
            {report.worst && (
              <div>
                <dt>一番の負け</dt>
                <dd className="neg">
                  {formatMonthlyUsdc(report.worst.pnl)}（
                  {monthlyDayFormat.format(report.worst.at)}）
                </dd>
              </div>
            )}
            <div>
              <dt>注目</dt>
              <dd>
                宣言{report.declared}・的中{report.hits}・外れ{report.misses}
                （ニアミス{report.nearMisses}）
              </dd>
            </div>
            <div>
              <dt>停止</dt>
              <dd>
                {report.stops > 0
                  ? `${report.stops}回（${report.stopBreakdown
                      .map(([label, n]) => `${label}×${n}`)
                      .join("・")}）`
                  : "なし"}
              </dd>
            </div>
            {streaks.longest > 0 && (
              <div>
                <dt>草</dt>
                <dd>
                  連続 {streaks.current}日 ・ 最長 {streaks.longest}日
                </dd>
              </div>
            )}
          </dl>
          <p className="monthly-report-voice">{report.comment}</p>
          {best && (
            <p className="monthly-report-best">
              ⭐ ベスト：{monthlyDayFormat.format(best.at)}{" "}
              {highlightLabel(best)}
            </p>
          )}
          {counters === undefined && view === "prev" && (
            <p className="monthly-report-note">
              注目と停止の集計は、月報の導入後から。
            </p>
          )}
        </>
      )}
    </section>
  );
}
