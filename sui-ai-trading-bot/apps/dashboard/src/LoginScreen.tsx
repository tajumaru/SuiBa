import React, { useEffect, useRef, useState } from "react";
import { AgentAvatarArtwork } from "./AgentNarration.tsx";
import type { AgentPose } from "./agentNarration.ts";
import { LoginAttempts } from "./loginAttempt.ts";
import {
  removeLegacyPatternLock,
  type PatternMigrationResult,
} from "./patternLock.ts";

export type VerifyResult = { ok: true } | { ok: false; code: string };

/** Credentials stay in memory. Future authentication methods can use their own
 * verifier without reintroducing a pattern-derived persistent bearer token. */
export function LoginScreen({
  verify,
  onAuthenticated,
}: {
  verify: (token: string, signal?: AbortSignal) => Promise<VerifyResult>;
  onAuthenticated: (token: string) => void;
}) {
  const [phase, setPhase] = useState<
    "idle" | "verifying" | "error" | "success"
  >("idle");
  const [input, setInput] = useState("");
  const [alertText, setAlertText] = useState<string | null>(null);
  const [migration, setMigration] = useState<PatternMigrationResult | null>(
    null,
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(new LoginAttempts());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const result = removeLegacyPatternLock();
    setMigration((previous) =>
      previous === "removed" && result === "empty" ? previous : result,
    );
    return () => {
      mounted.current = false;
      attempts.current.invalidate();
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);
  const busy = phase === "verifying" || phase === "success";
  const pose: AgentPose =
    phase === "success"
      ? "pointSmile"
      : phase === "error"
        ? "normal"
        : phase === "verifying" || input
          ? "laptop"
          : "sleep";
  const caption =
    phase === "success"
      ? "おはようございます！"
      : phase === "verifying"
        ? "確認しています…"
        : phase === "error"
          ? "接続できませんでした。もう一度どうぞ"
          : input
            ? "起きました。入力中は一緒に打ってます"
            : "接続されるまで、番人は寝ています";

  async function submitToken(e: React.FormEvent) {
    e.preventDefault();
    if (!mounted.current || !input) return;
    const attempt = attempts.current.begin();
    if (!attempt) return;
    const token = input;
    setInput("");
    setPhase("verifying");
    setAlertText(null);
    try {
      const result = await verify(token, attempt.signal);
      if (!mounted.current || !attempts.current.current(attempt)) return;
      if (result.ok) {
        setPhase("success");
        const reduced = window.matchMedia?.(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        timer.current = setTimeout(
          () => {
            timer.current = null;
            if (mounted.current && attempts.current.complete(attempt))
              onAuthenticated(token);
          },
          reduced ? 0 : 900,
        );
      } else {
        attempts.current.release(attempt);
        setPhase("error");
        setAlertText(
          result.code === "UNAUTHORIZED"
            ? "管理トークンを確認できません。コード：UNAUTHORIZED"
            : `接続できませんでした。コード：${result.code}`,
        );
      }
    } catch {
      if (!mounted.current || !attempts.current.release(attempt)) return;
      setPhase("error");
      setAlertText("接続できませんでした。コード：NETWORK");
    }
  }
  function cancel() {
    attempts.current.invalidate();
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setInput("");
    setPhase("idle");
    setAlertText(null);
  }
  return (
    <main className={`login login-gate${phase === "error" ? " shake" : ""}`}>
      <div className="login-stage" aria-hidden="true">
        <div className="login-stage-art">
          <AgentAvatarArtwork pose={pose} />
        </div>
        {pose === "sleep" && <span className="login-stage-zzz">Zzz</span>}
      </div>
      <p className="login-cap" role="status">
        {caption}
      </p>
      <h1>市場を検証する。</h1>
      <p>実資金を使わない、ルールベースの取引ラボ。</p>
      <p className="login-notice">
        安全性を見直すため、パターンでのログイン・登録を停止しました。管理トークンを入力して接続してください。
      </p>
      {migration === "removed" && (
        <p className="login-notice">
          このブラウザに保存されていたパターン登録と暗号化トークンを削除しました。すでにコピーされたデータは無効化できません。心当たりのある場合は管理トークンを変更してください。
        </p>
      )}
      {migration === "failed" && (
        <div className="login-notice" role="alert">
          <p>
            ブラウザの保存データを削除できませんでした。このサイトの保存データをブラウザ設定から削除してください。ログインは引き続き利用できます。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => setMigration(removeLegacyPatternLock())}
          >
            保存データの削除を再試行
          </button>
        </div>
      )}
      <form onSubmit={submitToken} aria-busy={busy}>
        <label>
          管理トークン
          <input
            type="password"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (phase === "error") {
                setPhase("idle");
                setAlertText(null);
              }
            }}
            required
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            aria-describedby={alertText ? "login-error" : undefined}
          />
        </label>
        <button disabled={busy}>接続</button>
      </form>
      {busy && (
        <button type="button" onClick={cancel}>
          認証を取り消す
        </button>
      )}
      {alertText && (
        <p id="login-error" role="alert" className="login-alert">
          {alertText}
        </p>
      )}
      <p className="login-note">トークンはメモリ内でのみ保持します。</p>
    </main>
  );
}
