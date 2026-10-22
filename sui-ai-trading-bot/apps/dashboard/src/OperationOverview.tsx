import React from "react";
import type { OperationsSnapshot } from "./OperationsPanel.tsx";
import { operationReason } from "./operationLabels.ts";
export function operationSummary(d: OperationsSnapshot, stale = false) {
  const s = d.safety;
  if (stale) return { title: "状態不明", tone: "warning", message: "最新のAPI応答を確認できません。表示は最終取得時点の記録です。" };
  if (d.status === "ABNORMAL_STOP" || ["ABNORMAL_STOP", "EMERGENCY_STOP"].includes(s?.botState))
    return { title: "安全停止", tone: "error", message: operationReason(d.stopReason ?? s?.lastStopReason ?? "UNKNOWN") };
  if (s?.connectivity === "RECOVERING") return { title: "復旧確認中", tone: "warning", message: "通信の復旧後、安全条件を確認しています。注文は禁止されています。" };
  if (s?.connectivity === "DEGRADED" || d.status === "DATA_DELAYED") return { title: "通信障害・一時待機", tone: "warning", message: "通信または市場データを確認してください。売買可能とは限りません。" };
  if (d.status === "STOPPED") return { title: s?.botState === "MANUAL_STOP" ? "手動停止" : "停止中・理由未確定", tone: "warning", message: d.stopReason ? operationReason(d.stopReason) : "Botは停止しています。停止理由の記録とPAPER開始条件を確認してください。" };
  if (d.status === "RUNNING" && s?.ordersAllowed && d.timing?.transportRecent && ["FRESH", "UPDATING"].includes(d.timing.dataStatus)) return { title: "正常稼働", tone: "healthy", message: "売買条件を満たした場合のみ、PAPERで仮想売買します。" };
  return { title: "状態不明", tone: "warning", message: "正常稼働と判断できる証拠が不足しています。詳細診断を確認してください。" };
}
export function OperationSummary({ data, stale }: { data: OperationsSnapshot; stale: boolean }) {
 const v = operationSummary(data, stale);
 return <section className={`operation-hero ${v.tone}`} aria-label="運用状態"><small className="operation-mode">{data.mode} · {data.mode === "PAPER" ? "仮想売買・実資金は使用しません" : "実資金の売買"}</small><h2 className="operation-state" role="status"><span aria-hidden="true">{v.tone === "healthy" ? "✓" : "!"}</span> {v.title}</h2><p>{v.message}</p></section>;
}
