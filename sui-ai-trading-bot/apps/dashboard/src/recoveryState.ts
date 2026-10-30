import type { BotEngine } from "../../worker/src/engine.ts";
import { operationReason } from "./operationLabels.ts";

type State = ReturnType<BotEngine["snapshot"]>;
type RecoverySnapshot = {
  mode: string;
  runtime: Pick<State["runtime"], "running" | "emergency" | "error">;
  safety: State["safety"];
};
export interface RecoveryStatus {
  title:
    | "正常稼働"
    | "停止中"
    | "通信確認中"
    | "通信異常"
    | "状態取得失敗"
    | "データ更新中";
  tone: "ok" | "caution" | "alert" | "unknown";
  reason: string;
  safety: string;
  next: string;
  canStart: boolean;
  automatic: boolean;
}

/** Presentation only. The authenticated server remains the final start gate. */
export function recoveryStatus(
  data: RecoverySnapshot | null,
  stale = false,
  checking = false,
): RecoveryStatus {
  if (stale)
    return {
      title: "状態取得失敗",
      tone: "unknown",
      reason: "最新のBot状態を取得できません。通信異常かどうかは未確認です。",
      safety: "Botの稼働・注文可否は未確認です。この画面からは開始できません。",
      next: "「状態を再取得」を押してください。取得できない場合は通信診断を開いてください。",
      canStart: false,
      automatic: false,
    };
  if (!data || checking)
    return {
      title: "通信確認中",
      tone: "caution",
      reason: "最新のBot状態を確認しています。",
      safety: "確認が終わるまで、この画面からは開始できません。",
      next: "状態の取得が終わるまでお待ちください。",
      canStart: false,
      automatic: false,
    };
  const { runtime, safety: s } = data;
  if (
    runtime.emergency ||
    runtime.error ||
    ["EMERGENCY_STOP", "ABNORMAL_STOP"].includes(s?.botState)
  )
    return {
      title: "停止中",
      tone: "alert",
      reason:
        runtime.emergency || s?.botState === "EMERGENCY_STOP"
          ? "緊急停止が設定されています。"
          : operationReason(runtime.error ?? s?.lastStopReason ?? "UNKNOWN"),
      safety:
        "安全停止中です。新規PAPER注文は禁止されています。自動再開しません。",
      next: "通信診断で原因を確認し、「解除の手順へ」から停止を解除してください。その後、手動で開始します。",
      canStart: false,
      automatic: false,
    };
  if (s?.connectivity === "DEGRADED" || s?.connectivity === "RECOVERING") {
    const automatic = s.resumePending === true;
    return {
      title: s.connectivity === "DEGRADED" ? "通信異常" : "通信確認中",
      tone: s.connectivity === "DEGRADED" ? "alert" : "caution",
      reason:
        s.connectivity === "DEGRADED"
          ? "外部APIへの通信失敗を検出しました。"
          : "通信の復旧後、安全条件を確認しています。",
      safety:
        "新規PAPER注文は禁止されています。復旧未確認のため開始できません。",
      next: automatic
        ? "自動復旧を待ってください。安全確認後にのみPAPER運用を自動再開します。進捗は通信診断で確認できます。"
        : "通信診断で復旧状況を確認してください。安全確認が完了しても自動再開しません。手動で開始してください。",
      canStart: false,
      automatic,
    };
  }
  if (data.mode !== "PAPER" || s?.connectivity !== "HEALTHY" || s.resumePending)
    return {
      title: "通信確認中",
      tone: "caution",
      reason: "開始に必要な安全状態を確認できません。",
      safety: "この画面からは開始できません。",
      next: "通信診断を開き、最新の安全状態を確認してください。",
      canStart: false,
      automatic: false,
    };
  if (runtime.running && s.marketUpdating === true)
    return {
      title: "データ更新中",
      tone: "caution",
      reason: "最新の市場データを取得しています。",
      safety: "更新中は新しい注文を保留しています。",
      next: "更新が終わると自動で表示が戻ります。",
      canStart: false,
      automatic: false,
    };
  if (!runtime.running && s.botState === "MANUAL_STOP")
    return {
      title: "停止中",
      tone: "caution",
      reason: "PAPER Botは停止しています。",
      safety: "新規PAPER注文は行いません。通信復旧だけでは自動再開しません。",
      next: "保存済みの条件を確認し、「PAPER運用開始」を押してください。開始時にもサーバーが安全条件を確認します。",
      canStart: true,
      automatic: false,
    };
  if (
    runtime.running &&
    ["HEALTHY", "RUNNING"].includes(s.botState) &&
    s.ordersAllowed
  )
    return {
      title: "正常稼働",
      tone: "ok",
      reason: "通信と運用の安全条件を確認できています。",
      safety: "売買条件を満たした場合のみPAPERで仮想売買します。",
      next: "操作は不要です。",
      canStart: false,
      automatic: false,
    };
  return {
    title: "通信確認中",
    tone: "caution",
    reason: "注文に必要なデータ・安全条件を確認しています。",
    safety: "新規PAPER注文は許可されていません。",
    next: "次の自動更新をお待ちください。確認が続く場合は通信診断を開いてください。",
    canStart: false,
    automatic: false,
  };
}
