import { useMemo } from "react";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import { analyseFills, type SliceStat } from "./fillAnalysis.ts";
import { formatMonthlyUsdc } from "./monthlyReport.ts";

/**
 * Condition-sliced performance （条件別の成績） under the
 * order history: the bot's real closes, grouped by the
 * conditions of the buy that opened each position. Pure
 * presentation over analyseFills — see that module for the
 * attribution rules and the coverage limits it surfaces.
 */

function SliceTable({
  title,
  rows,
}: {
  title: string;
  rows: SliceStat[];
}) {
  if (!rows.length) return null;
  return (
    <>
      <p className="fill-analysis-seg">{title}</p>
      <table className="fill-analysis-table">
        <thead>
          <tr>
            <th>条件</th>
            <th>決済</th>
            <th>勝率</th>
            <th>損益</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <td>{r.closes}</td>
              <td>{r.winRatePct}%</td>
              <td className={r.pnlUsdc >= 0 ? "pos" : "neg"}>
                {formatMonthlyUsdc(r.pnlUsdc)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function FillAnalysisCard({
  trades,
  candles,
}: {
  trades: readonly Fill[];
  candles: readonly Candle[];
}) {
  const a = useMemo(() => analyseFills(trades, candles), [trades, candles]);
  if (!trades.length) return null;
  return (
    <section className="fill-analysis" aria-label="条件別の成績">
      <h4>条件別の成績</h4>
      {a.closes === 0 ? (
        <p className="fill-analysis-empty">まだ集計できる決済がない。</p>
      ) : (
        <>
          <SliceTable title={`買った時間帯（${a.closes}決済）`} rows={a.byHour} />
          <SliceTable
            title={`買ったときのRSI（復元できた${a.rsiCovered}決済）`}
            rows={a.byRsi}
          />
          <p className="fill-analysis-note">
            損益は「その決済が閉じた買い」の条件に付けた。RSIはチャートの足から復元した目安。
            {a.unattributed > 0
              ? `買いが記録の範囲外の決済${a.unattributed}件は除いた。`
              : ""}
          </p>
        </>
      )}
    </section>
  );
}
