import React from "react";
import type { OperationMonitor } from "../../worker/src/operations.ts";
import { dateTime } from "./presentation.ts";
import { Reason } from "./Reason.tsx";
type Snapshot = ReturnType<OperationMonitor["snapshot"]>;
type Safety = Snapshot["safety"];
type Timing = Snapshot["timing"];
const labels: Record<string, string> = {
  HEALTHY: "正常",
  DEGRADED: "通信異常",
  RECOVERING: "通信確認中",
  ABNORMAL_STOP: "異常停止",
  MANUAL_STOP: "手動停止・開始待ち",
  EMERGENCY_STOP: "緊急停止",
};
export type ConnectivityTone =
  "ok" | "caution" | "alert" | "neutral" | "unknown";
export interface ConnectivityStatus {
  message: string;
  tone: ConnectivityTone;
  allowed: boolean;
  connectivityLabel: string;
  botStateLabel: string;
}
/**
 * The single derivation of the safety wording and severity from a
 * safety snapshot. The full panel (operations diagnostics) and the
 * compact dashboard strip both render from this so their messages
 * can never drift apart.
 */
export function connectivityStatus(
  safety: Safety,
  stale = false,
): ConnectivityStatus {
  const allowed = !stale && safety.ordersAllowed;
  const message = stale
    ? "状態取得失敗。Botの稼働・注文可否は未確認です。状態を再取得してください。"
    : safety.botState === "EMERGENCY_STOP"
      ? "緊急停止中です。通信が復旧しても自動再開しません。"
      : safety.botState === "ABNORMAL_STOP"
        ? "安全停止中です。停止理由を確認してください。自動再開しません。"
        : safety.connectivity === "DEGRADED"
          ? "通信異常を検出しました。PAPER注文は禁止されています。復旧状況は通信診断で確認してください。"
          : safety.connectivity === "RECOVERING"
            ? "通信は復旧しましたが、安全確認中のため注文は停止しています。"
            : safety.recoveredAt && allowed
              ? "安全確認が完了しました。PAPER検証を再開しました。"
              : allowed
                ? "通信・運用状態は正常です。売買条件を満たした場合のみPAPER注文を行います。"
                : safety.botState === "MANUAL_STOP"
                  ? "PAPER Botは停止中です。通信の正常化だけでは開始しません。"
                  : "データ・安全条件を確認中です。新規PAPER注文は停止しています。";
  const tone: ConnectivityTone = stale
    ? "unknown"
    : safety.botState === "EMERGENCY_STOP" ||
        safety.botState === "ABNORMAL_STOP" ||
        safety.connectivity === "DEGRADED"
      ? "alert"
      : safety.connectivity === "RECOVERING"
        ? "caution"
        : allowed
          ? "ok"
          : "neutral";
  return {
    message,
    tone,
    allowed,
    connectivityLabel: stale ? "状態取得失敗" : labels[safety.connectivity],
    botStateLabel: stale ? "状態取得失敗" : labels[safety.botState],
  };
}
/** The detailed definition list shared by the full panel and the strip. */
export function ConnectivityDetails({
  safety,
  timing,
  stale = false,
  allowed,
}: {
  safety: Safety;
  timing?: Timing;
  stale?: boolean;
  allowed: boolean;
}) {
  return (
    <>
      <dl>
        <dt>現在の通信状態</dt>
        <dd>{stale ? "状態取得失敗" : labels[safety.connectivity]}</dd>
        <dt>PAPER Botの状態</dt>
        <dd>{stale ? "状態取得失敗" : labels[safety.botState]}</dd>
        <dt>新規注文</dt>
        <dd>
          {stale
            ? "未確認（画面からの開始は不可）"
            : allowed
              ? "注文可能（売買条件の確認後）"
              : "注文禁止"}
        </dd>
        <dt>安全制御の状態</dt>
        <dd>
          {stale
            ? "状態不明"
            : ({
                RUNNING: "正常稼働",
                DEGRADED: "通信品質低下・注文停止",
                PAUSED: "安全確認待ち・注文停止",
                STOPPED: "手動停止・開始待ち",
                FAULTED: "重大障害・異常解除が必要",
              }[safety.controlState] ?? "状態不明")}
        </dd>
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
        <dt>再開に必要な確認</dt>
        <dd>
          全時間足と板が新しく欠損がないこと、Suiへの接続、残高・保有数量・注文と約定の整合性、通信の待機終了を確認します。
          正常確認は{safety.limits.healthyCycles}周期以上、
          {safety.limits.minimumHealthyMs / 1000}秒以上続く必要があります。
          注文直前にもリスク制限と利益保護を確認します。
        </dd>
        <dt>復旧待機の理由</dt>
        <dd>
          {stale
            ? "最新の状態を取得できていません。"
            : allowed
              ? "待機条件はありません。注文ごとの確認は継続します。"
              : safety.botState === "ABNORMAL_STOP" ||
                  safety.botState === "EMERGENCY_STOP"
                ? "停止原因の解消と、明示的な異常解除・開始操作が必要です。"
                : safety.botState === "MANUAL_STOP"
                  ? "自動再開の予定はありません。安全確認後に手動で開始してください。"
                  : safety.resumePending
                    ? "通信と市場データの連続した正常確認を待っています。確認中は注文しません。"
                    : "データ・安全条件の確認を待っています。確認中は新規注文しません。"}
        </dd>
      </dl>
      {!stale && safety.resumePending && (
        <p>
          復旧条件をすべて満たした場合にPAPERのみ再開します。停止操作を行うと自動再開を取り消します。
        </p>
      )}
    </>
  );
}
export function ConnectivityPanel({
  safety,
  timing,
  stale = false,
}: {
  safety?: Safety;
  timing?: Timing;
  stale?: boolean;
}) {
  if (!safety) return null;
  const status = connectivityStatus(safety, stale);
  return (
    <section
      className="card connectivity-panel"
      aria-label="通信とPAPER注文の状態"
    >
      <h2>通信とPAPER注文</h2>
      <p role="status" aria-live="polite" aria-atomic="true">
        {status.message}
      </p>
      <ConnectivityDetails
        safety={safety}
        timing={timing}
        stale={stale}
        allowed={status.allowed}
      />
    </section>
  );
}
/**
 * The compact form for the dashboard tab: the live status message and
 * the headline chips stay visible as a one-or-two-line strip, with the
 * full detail list one expansion away. Abnormal states (communication
 * failure, safety stop, emergency stop) carry an alert tone so the
 * strip reads as abnormal by color as well as by text.
 */
export function ConnectivityStrip({
  safety,
  timing,
  stale = false,
}: {
  safety?: Safety;
  timing?: Timing;
  stale?: boolean;
}) {
  if (!safety) return null;
  const status = connectivityStatus(safety, stale);
  return (
    <section
      className={`card connectivity-strip tone-${status.tone}`}
      aria-label="通信とPAPER注文の状態"
    >
      <div className="connectivity-strip-head">
        <h2>通信とPAPER注文</h2>
        <p role="status" aria-live="polite" aria-atomic="true">
          {status.message}
        </p>
      </div>
      <ul className="connectivity-chips">
        <li>通信：{status.connectivityLabel}</li>
        <li>
          新規注文：
          {stale ? "未確認" : status.allowed ? "注文可能" : "注文禁止"}
        </li>
        <li>Bot：{status.botStateLabel}</li>
      </ul>
      <details className="connectivity-details">
        <summary>詳細を表示</summary>
        <ConnectivityDetails
          safety={safety}
          timing={timing}
          stale={stale}
          allowed={status.allowed}
        />
      </details>
    </section>
  );
}
