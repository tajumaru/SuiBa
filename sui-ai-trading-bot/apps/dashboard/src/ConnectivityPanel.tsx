import React from "react";
import type { OperationMonitor } from "../../worker/src/operations.ts";
import { dateTime } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
type Snapshot = ReturnType<OperationMonitor["snapshot"]>;
const labels: Record<string, string> = {
  HEALTHY: "正常",
  DEGRADED: "通信障害",
  RECOVERING: "復旧確認中",
  ABNORMAL_STOP: "異常停止",
  MANUAL_STOP: "手動停止・開始待ち",
  EMERGENCY_STOP: "緊急停止",
};
export function ConnectivityPanel({
  safety,
  timing,
  stale = false,
}: {
  safety?: Snapshot["safety"];
  timing?: Snapshot["timing"];
  stale?: boolean;
}) {
  if (!safety) return null;
  const allowed = !stale && safety.ordersAllowed;
  const message = stale
    ? "最新の状態を確認できません。接続を確認してください。"
    : safety.botState === "EMERGENCY_STOP"
      ? "緊急停止中です。通信が復旧しても自動再開しません。"
      : safety.botState === "ABNORMAL_STOP"
        ? "安全停止中です。停止理由を確認してください。自動再開しません。"
        : safety.connectivity === "DEGRADED"
          ? "通信障害を検出しました。PAPER注文を一時停止し、復旧を確認しています。"
          : safety.connectivity === "RECOVERING"
            ? "通信は復旧しましたが、安全確認中のため注文は停止しています。"
            : safety.recoveredAt && allowed
              ? "安全確認が完了しました。PAPER検証を再開しました。"
              : allowed
                ? "通信・運用状態は正常です。売買条件を満たした場合のみPAPER注文を行います。"
                : "PAPER Botは停止中です。通信の正常化だけでは開始しません。";
  return (
    <section
      className="card connectivity-panel"
      aria-label="通信とPAPER注文の状態"
    >
      <h2>通信とPAPER注文</h2>
      <p role="status" aria-live="polite" aria-atomic="true">
        {message}
      </p>
      <dl>
        <dt>現在の通信状態</dt>
        <dd>{stale ? "状態不明" : labels[safety.connectivity]}</dd>
        <dt>PAPER Botの状態</dt>
        <dd>{stale ? "状態不明" : labels[safety.botState]}</dd>
        <dt>新規注文</dt>
        <dd>{allowed ? "注文可能（売買条件の確認後）" : "注文禁止"}</dd>
        <dt>最後の安全停止理由</dt>
        <dd>
          {safety.lastStopReason ? (
            <Reason code={safety.lastStopReason} />
          ) : (
            "記録なし"
          )}
        </dd>
        <dt>最新のAPIエラー</dt>
        <dd>
          {safety.latestApiError ? (
            <>
              <Reason code={safety.latestApiError.code} /> ·{" "}
              {safety.latestApiError.api} ·{" "}
              {dateTime(safety.latestApiError.occurredAt)}
            </>
          ) : (
            "記録なし"
          )}
        </dd>
        <dt>復旧確認</dt>
        <dd>
          {safety.healthyCycles} / {safety.limits.healthyCycles} 周期 ·
          正常確認の間隔 {safety.limits.minimumHealthyMs / 1000}秒以上
        </dd>
        <dt>最終正常取得</dt>
        <dd>
          {dateTime(timing?.lastFetchSuccessAt ?? safety.lastMarketSuccessAt)}
        </dd>
      </dl>
      {safety.resumePending && (
        <p>
          復旧条件をすべて満たした場合にPAPERのみ再開します。停止操作を行うと自動再開を取り消します。
        </p>
      )}
    </section>
  );
}
