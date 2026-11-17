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
    <section className="stop-history" aria-label="過去の停止理由">
      <h3>過去の停止理由</h3>
      {error && <p role="alert">{error}</p>}
      {!data ? (
        <p>{error ? "停止記録を取得できません。" : "停止記録を取得中…"}</p>
      ) : (
        <>
          {!data.stopReason && data.safety?.lastStopReason && (
            <p className="stop-history-last">
              <span>
                直近の停止理由{" "}
                <span className="stop-history-released">解除済み</span>
              </span>
              <strong>{reason(data.safety.lastStopReason)}</strong>
            </p>
          )}
          {report && (
            <details className="stop-history-period">
              <summary>直近7日間 · {stops.length}件（日本時間）</summary>
              <p>
                {dateTime(report.from)} 〜 {dateTime(report.until)}
              </p>
            </details>
          )}
          {stops.length === 0 ? (
            <p>この期間の停止記録はありません。</p>
          ) : (
            <ul className="stop-history-list">
              {stops.map((s, i) => (
                <li key={`${s.timestamp}-${i}`}>
                  <time dateTime={new Date(s.timestamp).toISOString()}>
                    {dateTime(s.timestamp).replace("（日本時間）", "")}
                  </time>
                  <strong>{reason(s.reason)}</strong>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
