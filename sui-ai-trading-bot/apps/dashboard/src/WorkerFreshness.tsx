import { useEffect, useState } from "react";
import { botVital } from "./botVital.ts";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import { dateTime } from "./presentation.ts";

/** Text evidence from the shared operations feed, with the existing freshness rules. */
export function WorkerFreshness({
  data,
  stale = false,
}: {
  data: OperationsSnapshot | null;
  stale?: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  const [receivedAt, setReceivedAt] = useState(Date.now);
  useEffect(() => {
    setReceivedAt(Date.now());
    setNow(Date.now());
  }, [data]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    window.addEventListener("pageshow", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pageshow", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const vital = data ? botVital(data, stale, now, receivedAt) : null;
  const status = vital
    ? (
        {
          alive: "稼働中",
          weak: "通信・データを確認中",
          sleeping: "停止中",
          flatlined: "安全停止",
          unknown: "状態確認中",
        } as const
      )[vital.state]
    : "状態を確認中";
  return (
    <section aria-label="Workerの状態" className="worker-freshness">
      <h3>Workerの状態</h3>
      <p role="status">
        {status}
        {stale ? "（最新情報を取得できません）" : ""}
      </p>
      {/* One line since 2026-11-19 (owner: the overview carried
          too much information): the heartbeat carries the full
          timestamp, the last successful analysis rides along as
          an age only — when analysis stalls its age grows while
          the heartbeat stays fresh, so the failure signal stays
          visible without a second near-identical timestamp. */}
      <dl>
        <dt>Workerの心拍</dt>
        <dd>
          {data ? dateTime(data.lastHeartbeatAt) : "未取得"}
          {vital?.heartbeatSecondsAgo != null && (
            <span className="worker-freshness-age">
              （{vital.heartbeatSecondsAgo}秒前）
            </span>
          )}
          {vital?.lastAnalysisSecondsAgo != null && (
            <span className="worker-freshness-age">
              ・最終分析 {vital.lastAnalysisSecondsAgo}秒前
            </span>
          )}
        </dd>
      </dl>
    </section>
  );
}
