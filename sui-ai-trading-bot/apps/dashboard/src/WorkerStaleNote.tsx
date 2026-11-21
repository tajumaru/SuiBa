import { useEffect, useState } from "react";
import { botVital } from "./botVital.ts";
import type { OperationsSnapshot } from "./operationsTypes.ts";

/**
 * Overview freshness note (owner's call, 2026-11-22): the old
 * always-on Worker status panel — heartbeat timestamp line,
 * EPOCH/TPS readout and the heartbeat Sui mark — is retired.
 * While the worker is alive and the feed is fresh this renders
 * nothing: the operation bar already says 正常稼働. The note
 * appears as a single line only when the evidence goes stale
 * or connectivity is degraded, the states a frozen screen
 * would otherwise hide. Stopped and safety-stop states stay
 * silent here — the operation bar and the recovery panels
 * already announce them.
 */
export function WorkerStaleNote({
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
  const show =
    stale ||
    vital == null ||
    vital.state === "unknown" ||
    vital.state === "weak";
  if (!show) return null;
  const status = stale
    ? "最新情報を取得できません"
    : vital?.state === "weak"
      ? "通信・データを確認中"
      : "状態確認中";
  const ages: string[] = [];
  if (vital?.heartbeatSecondsAgo != null)
    ages.push(`心拍 ${vital.heartbeatSecondsAgo}秒前`);
  if (vital?.lastAnalysisSecondsAgo != null)
    ages.push(`最終分析 ${vital.lastAnalysisSecondsAgo}秒前`);
  return (
    <p className="worker-stale-note" role="status">
      {status}
      {ages.length > 0 && <span>（{ages.join("・")}）</span>}
    </p>
  );
}
