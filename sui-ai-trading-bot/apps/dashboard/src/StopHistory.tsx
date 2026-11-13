import type { OperationsSnapshot } from "./operationsTypes.ts";
import { dateTime, reason } from "./presentation.ts";

/** Uses the existing recorded report and safety state; never creates stop records. */
export function StopHistory({
  data,
  error,
}: {
  data: OperationsSnapshot | null;
  error?: string;
}) {
  const report = data?.reports.find((r) => r.hours === 168);
  const stops = report?.stopReasons ?? [];
  return (
    <section aria-label="過去の停止理由">
      <h3>過去の停止理由</h3>
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p>{error ? "停止記録を取得できません。" : "停止記録を取得中…"}</p>
      ) : (
        <>
          {!data.stopReason && data.safety?.lastStopReason && (
            <p>
              過去の停止理由（現在は解除済み）：
              {reason(data.safety.lastStopReason)}
            </p>
          )}
          {report && (
            <p className="panel-meta">
              直近7日間：{dateTime(report.from)} 〜 {dateTime(report.until)}
            </p>
          )}
          {stops.length === 0 ? (
            <p>この期間の停止記録はありません。</p>
          ) : (
            <ul>
              {stops.map((s, i) => (
                <li key={`${s.timestamp}-${i}`}>
                  {dateTime(s.timestamp)}：{reason(s.reason)}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
