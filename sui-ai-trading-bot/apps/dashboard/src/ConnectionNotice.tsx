import React from "react";

export function ConnectionNotice({
  receivedAt,
}: {
  receivedAt: number | null;
}) {
  return (
    <aside
      className="connection-notice"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <strong>Botに接続できません。再接続しています…</strong>
      <span>再起動中の可能性があります。接続が戻ると自動で更新します。</span>
      <span>
        {receivedAt === null ? (
          "まだデータを取得できていません。"
        ) : (
          <>
            表示中の価格・状態は接続断前の情報です。最終取得：
            <time dateTime={new Date(receivedAt).toISOString()}>
              {new Date(receivedAt).toLocaleString("ja-JP", { hour12: false })}
            </time>
          </>
        )}
      </span>
    </aside>
  );
}
