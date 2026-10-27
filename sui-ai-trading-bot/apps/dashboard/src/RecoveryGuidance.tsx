import React from "react";
import type { RecoveryStatus } from "./recoveryState.ts";

export function RecoveryGuidance({
  status,
  onDiagnose,
  onRefresh,
  checking,
  onStop,
}: {
  status: RecoveryStatus;
  onDiagnose: () => void;
  onRefresh: () => void;
  checking: boolean;
  onStop?: () => void;
}) {
  if (status.title === "正常稼働") return null;
  return (
    <section
      className={`recovery-guidance tone-${status.tone}`}
      aria-label="復旧ガイド"
    >
      <div
        className="recovery-guidance-summary"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <h2 className="recovery-status-title">{status.title}</h2>
        <dl>
          <dt>原因</dt>
          <dd>{status.reason}</dd>
          <dt>安全状態</dt>
          <dd id="recovery-start-block">{status.safety}</dd>
          <dt>次の操作</dt>
          <dd>{status.next}</dd>
        </dl>
      </div>
      <div className="recovery-guidance-actions">
        <button type="button" onClick={onDiagnose}>
          通信診断を開く
        </button>
        <button
          type="button"
          className="secondary"
          onClick={onRefresh}
          disabled={checking}
        >
          {checking ? "状態を確認しています…" : "状態を再取得"}
        </button>
        {status.automatic && onStop && (
          <button type="button" className="secondary" onClick={onStop}>
            自動再開を取り消して停止
          </button>
        )}
      </div>
    </section>
  );
}
