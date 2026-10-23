import type { OperationsSnapshot } from "./operationsTypes.ts";
import type { BotEngine } from "../../worker/src/engine.ts";

export type ControlState = ReturnType<BotEngine["snapshot"]>;
export type Readiness = { status: "GO" | "NO_GO"; reason: string };
// This is the reviewed release decision, not a live health check or a UI approval.
// Update only alongside the reviewed readiness document and its evidence.
export const validationReadiness: Readiness = {
  status: "NO_GO",
  reason:
    "固定Dockerイメージでの事前確認と外部通信経路の安定性確認が未完了です。PAPER_RUN2_READINESS.mdの未達事項を解消し、別途開始承認を得てください。",
};

export function validationControl(
  data: OperationsSnapshot,
  state?: ControlState,
  stale = false,
  readiness = validationReadiness,
) {
  const running = ["RUNNING", "DATA_DELAYED"].includes(data.status);
  const abnormal =
    data.status === "ABNORMAL_STOP" ||
    !!state?.runtime.error ||
    !!state?.runtime.emergency;
  const reasons: string[] = [];
  if (stale || !state)
    reasons.push(
      "最新状態を取得できません。接続と管理トークンを確認し、更新を待ってください。",
    );
  if (readiness.status !== "GO")
    reasons.push(
      "NO-GO：上の事前判定の未達事項を解消し、別途開始承認を得てください。",
    );
  if (state?.mode !== "PAPER" || data.mode !== "PAPER")
    reasons.push("PAPER専用環境であることを確認してください。");
  if (!state?.settings.profitGuardEnabled)
    reasons.push("設定でProfit Guardを有効にして保存してください。");
  const measureReasons = [...reasons];
  if (!data.validation)
    measureReasons.push(
      "検証機能が利用できません。検証専用環境を確認してください。",
    );
  if (data.validation?.session)
    measureReasons.push(
      "計測は開始済みです。記録の上書き・再開始はできません。",
    );
  if (running || state?.runtime.running)
    measureReasons.push("PAPER Botを停止してから計測を開始してください。");
  const startReasons = [...reasons];
  if (!data.validation?.session)
    startReasons.push(
      "先にステップ1の24時間計測を開始し、開始日時を確認してください。",
    );
  if (running || state?.runtime.running)
    startReasons.push("PAPER Botは稼働中です。");
  if (abnormal)
    startReasons.push(
      "停止理由を解消し、RESETで停止状態を解除してください。解除だけでは再開しません。",
    );
  if (data.safety?.connectivity !== "HEALTHY" || data.safety?.resumePending)
    startReasons.push(
      "通信と安全確認の完了を待ってください。復旧待ちの間は注文禁止です。",
    );
  if (data.apis.some((a) => a.backoff || a.exhausted))
    startReasons.push(
      "APIの再試行待機・上限を確認してください。待機解除と原因解消が必要です。",
    );
  if (
    !state?.connection.healthy ||
    Date.now() - (state?.connection.checkedAt ?? 0) > 180000
  )
    startReasons.push(
      "Sui接続の正常確認が必要です。最新の正常応答を待ってください。",
    );
  if (!data.accounting.ledger.ok)
    startReasons.push(
      "残高・損益の不整合があります。詳細診断で台帳を確認してください。",
    );
  if ((data.timing.fetchElapsedMs ?? 0) > 45000)
    startReasons.push(
      "市場データ取得が45秒を超えています。取得の正常化を待ってください。",
    );
  const tone = stale
    ? "warning"
    : abnormal
      ? "danger"
      : data.safety?.connectivity !== "HEALTHY" ||
          data.status === "DATA_DELAYED"
        ? "warning"
        : running
          ? "healthy"
          : startReasons.length === 0 || measureReasons.length === 0
            ? "ready"
            : "stopped";
  return { running, abnormal, measureReasons, startReasons, tone };
}
