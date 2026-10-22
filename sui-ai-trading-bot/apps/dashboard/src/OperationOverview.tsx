import React from "react";
import type { OperationMonitor } from "../../worker/src/operations.ts";
type OperationsSnapshot = ReturnType<OperationMonitor["snapshot"]>;
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
export function noTradeReasons(d: OperationsSnapshot, hours: number, stale = false) {
 const r = d.reports.find(r => r.hours === hours);
 if (!r || r.tradeCount > 0) return [];
 const reasons: string[] = [];
 if (stale) return ["原因未確定：最新のAPI応答を取得できません"];
 if (["STOPPED", "ABNORMAL_STOP"].includes(d.status)) reasons.push("Botが停止している（現在のAPI状態）");
 if (!d.timing?.transportRecent || ["UNKNOWN", "STALE"].includes(d.timing?.dataStatus)) reasons.push("データ取得に問題がある（現在の通信・鮮度）");
 if (r.profitGuardSkipped > 0) reasons.push(`利益保護で見送り：期間内 ${r.profitGuardSkipped}件`);
 if (r.riskSkipped > 0) reasons.push(`リスク制限で見送り：期間内 ${r.riskSkipped}件`);
 const pending = d.candidates.filter(c => c.createdAt >= r.from && c.createdAt <= r.until && c.finalAction === "PENDING");
 if (pending.length) reasons.push(`注文候補はあるが約定していない：直近記録 ${pending.length}件`);
 if (!reasons.length) reasons.push("原因未確定：候補0件だけでは売買条件の不成立を断定できません");
 return reasons;
}
export function OperationGuidance({ data, hours, stale }: { data: OperationsSnapshot; hours: number; stale: boolean }) {
 const reasons = noTradeReasons(data, hours, stale);
 const v = operationSummary(data, stale);
 const checks: string[] = [];
 if (stale) checks.push("画面とAPIの接続を確認し、最新状態を取得");
 if (!stale && (data.safety?.connectivity !== "HEALTHY" || data.apis?.some(a => a.failed || a.backoff || a.exhausted))) checks.push("DeepBook・市場データAPIの通信を詳細診断で確認");
 if (!stale && (!data.timing?.transportRecent || ["STALE", "UNKNOWN"].includes(data.timing?.dataStatus))) checks.push("市場データの鮮度とローソク足品質を確認");
 if (!stale && v.title !== "正常稼働") checks.push("停止理由とPAPER再開条件を確認");
 if (!data.accounting.ledger.ok || data.accounting.latest?.ok === false) checks.unshift("残高・損益照合の不一致を確認");
 return <>{reasons.length > 0 && <section aria-label="なぜ売買されない？"><h2>なぜ売買されない？</h2><ul>{reasons.map(r => <li key={r}>{r}</li>)}</ul><small>現在の状態と選択期間の記録を区別しています。現在の停止だけで期間全体の原因は確定しません。</small></section>}{checks.length > 0 && <section className="operation-next"><h2>次に確認すること</h2><ol>{checks.slice(0, 3).map(c => <li key={c}>{c}</li>)}</ol><a href="#operation-diagnostics">詳細診断へ</a></section>}</>;
}
