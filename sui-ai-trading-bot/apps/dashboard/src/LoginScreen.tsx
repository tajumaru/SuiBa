import React, { useEffect, useRef, useState } from "react";
import { AgentAvatarArtwork } from "./AgentNarration.tsx";
import type { AgentPose } from "./agentNarration.ts";
import { PatternPad, type PatternPadTone } from "./PatternPad.tsx";
import {
  clearDismissed,
  clearEnrollment,
  isDismissed,
  isEnrolled,
  isPatternLockSupported,
  isValidPattern,
  unlockWithPattern,
} from "./patternLock.ts";

/**
 * The login gate: the white character keeps watch over it.
 *
 * Two ways in, one credential. The management token is the real
 * key and is now verified with the worker BEFORE the app shell
 * opens (a wrong token used to enter a broken shell; it now
 * stays at the gate, where the keeper can shake its head). The
 * pattern is the optional device convenience lock from
 * patternLock.ts: it only ever decrypts a token that a verified
 * token login stored on this device, and the recovered token
 * goes through the same verification.
 *
 * The keeper's states mirror the gate's: asleep until touched,
 * typing along at the laptop while the token is typed, following
 * the finger (point pose) while a pattern is traced, and the
 * smile for a verified hello.
 */

export type VerifyResult = { ok: true } | { ok: false; code: string };

/** The slice of patternLock the gate needs; injectable for tests. */
export interface LoginLockPort {
  supported(): boolean;
  enrolled(): boolean;
  dismissed(): boolean;
  unlock(pattern: number[]): Promise<string | null>;
  clear(): void;
  undismiss(): void;
}

const defaultPort: LoginLockPort = {
  supported: () => isPatternLockSupported(),
  enrolled: () => isEnrolled(),
  dismissed: () => isDismissed(),
  unlock: (pattern) => unlockWithPattern(pattern),
  clear: () => clearEnrollment(),
  undismiss: () => clearDismissed(),
};

type Phase = "idle" | "drawing" | "verifying" | "error" | "success";
type Mode = "pattern" | "token";

const CAPTION_SLEEP_PATTERN =
  "接続されるまで、番人は寝ています。パターンをなぞって起こしてね";
const CAPTION_SLEEP_TOKEN = "接続されるまで、番人は寝ています";
const CAPTION_TYPING = "起きました。入力中は一緒に打ってます";
const CAPTION_DRAWING = "なぞってる…門番が指についてきてます";
const CAPTION_VERIFYING = "確認しています…";
const CAPTION_SUCCESS = "おはようございます！";

export function LoginScreen({
  verify,
  onAuthenticated,
  port = defaultPort,
}: {
  verify: (token: string) => Promise<VerifyResult>;
  onAuthenticated: (token: string) => void;
  port?: LoginLockPort;
}) {
  const [enrolled, setEnrolled] = useState<boolean>(() => port.enrolled());
  const [mode, setMode] = useState<Mode>(() =>
    port.enrolled() ? "pattern" : "token",
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const [input, setInput] = useState("");
  const [caption, setCaption] = useState(() =>
    port.enrolled() ? CAPTION_SLEEP_PATTERN : CAPTION_SLEEP_TOKEN,
  );
  const [alertText, setAlertText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [padReset, setPadReset] = useState(0);
  const [padTone, setPadTone] = useState<PatternPadTone>("idle");
  const [dismissed, setDismissedState] = useState<boolean>(() =>
    port.dismissed(),
  );
  const timersRef = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  };
  useEffect(
    () => () => {
      timersRef.current.forEach((id) => window.clearTimeout(id));
    },
    [],
  );

  const pose: AgentPose =
    phase === "success"
      ? "pointSmile"
      : phase === "error"
        ? "normal"
        : phase === "verifying"
          ? mode === "pattern"
            ? "point"
            : "laptop"
          : phase === "drawing"
            ? "point"
            : mode === "token" && input.length > 0
              ? "laptop"
              : "sleep";

  function fail(captionText: string, alert: string) {
    setPhase("error");
    setCaption(captionText);
    setAlertText(alert);
    if (mode === "pattern") {
      setPadTone("error");
      later(() => {
        setPadTone("idle");
        setPadReset((n) => n + 1);
        setPhase((p) => (p === "error" ? "idle" : p));
      }, 1300);
    }
  }

  function succeed(token: string) {
    setPhase("success");
    setCaption(CAPTION_SUCCESS);
    setAlertText(null);
    setPadTone("success");
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    later(() => onAuthenticated(token), reduced ? 0 : 900);
  }

  async function verifyAndEnter(token: string, viaPattern: boolean) {
    setPhase("verifying");
    setCaption(CAPTION_VERIFYING);
    setAlertText(null);
    const result = await verify(token);
    if (result.ok) {
      succeed(token);
      return;
    }
    if (viaPattern && result.code === "UNAUTHORIZED") {
      // The stored token no longer works (rotated at the worker):
      // the enrolment can never succeed again, so drop it and
      // say so, instead of letting the pattern fail forever.
      port.clear();
      setEnrolled(false);
      setMode("token");
      setPhase("idle");
      setPadTone("idle");
      setPadReset((n) => n + 1);
      setCaption(CAPTION_SLEEP_TOKEN);
      setNotice(
        "保存していたトークンが使えなくなっていたので、この端末の登録を消しました。いまのトークンで入ってね",
      );
      return;
    }
    if (result.code === "UNAUTHORIZED")
      fail(
        "トークンが違うみたい。もう一度どうぞ",
        "管理トークンを確認できません。コード：UNAUTHORIZED",
      );
    else
      fail(
        "接続できませんでした。Botが起動しているか確認してね",
        `接続できませんでした。コード：${result.code}`,
      );
  }

  async function handlePatternComplete(sequence: number[]) {
    if (phase === "verifying" || phase === "success") return;
    if (!isValidPattern(sequence)) {
      fail(
        "短すぎるみたい。4つ以上の点をつないでね",
        "パターンが短すぎます。4つ以上の点をつないでください",
      );
      return;
    }
    setPhase("verifying");
    setCaption(CAPTION_VERIFYING);
    const stored = await port.unlock(sequence);
    if (stored === null) {
      fail(
        "パターンが違うみたい。もう一度なぞってね",
        "パターンが登録と一致しませんでした",
      );
      return;
    }
    await verifyAndEnter(stored, true);
  }

  function submitToken(e: React.FormEvent) {
    e.preventDefault();
    if (phase === "verifying" || phase === "success" || !input) return;
    const token = input;
    setInput("");
    void verifyAndEnter(token, false);
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
      {notice && <p className="login-notice">{notice}</p>}
      {mode === "pattern" ? (
        <>
          <PatternPad
            onComplete={(seq) => void handlePatternComplete(seq)}
            onDrawStart={() => {
              if (phase !== "verifying" && phase !== "success") {
                setPhase("drawing");
                setCaption(CAPTION_DRAWING);
                setAlertText(null);
                setPadTone("idle");
              }
            }}
            tone={padTone}
            resetKey={padReset}
            disabled={phase === "verifying" || phase === "success"}
          />
          {alertText && (
            <p role="alert" className="login-alert">
              {alertText}
            </p>
          )}
          <p className="login-note">
            この端末専用の簡易ロックです。トークンはパターンで暗号化してこの端末に保持しています
          </p>
          <div className="login-links">
            <button
              type="button"
              onClick={() => {
                setMode("token");
                setPhase("idle");
                setAlertText(null);
                setCaption(CAPTION_SLEEP_TOKEN);
              }}
            >
              トークンで入る
            </button>
            <button
              type="button"
              onClick={() => {
                port.clear();
                setEnrolled(false);
                setMode("token");
                setPhase("idle");
                setAlertText(null);
                setCaption(CAPTION_SLEEP_TOKEN);
                setNotice("この端末の登録を消しました");
              }}
            >
              この端末の登録を消す
            </button>
          </div>
        </>
      ) : (
        <>
          <form onSubmit={submitToken}>
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
                  if (phase === "idle" || phase === "error")
                    setCaption(
                      e.target.value ? CAPTION_TYPING : CAPTION_SLEEP_TOKEN,
                    );
                }}
                required
                autoComplete="off"
                disabled={phase === "verifying" || phase === "success"}
              />
            </label>
            <button disabled={phase === "verifying" || phase === "success"}>
              接続
            </button>
          </form>
          {alertText && (
            <p role="alert" className="login-alert">
              {alertText}
            </p>
          )}
          <p className="login-note">
            {enrolled
              ? "この端末には、トークンをパターンで暗号化して保持しています"
              : "トークンはメモリ内でのみ保持します。"}
          </p>
          {!enrolled && dismissed && port.supported() && (
            <button
              type="button"
              className="login-link"
              onClick={() => {
                port.undismiss();
                setDismissedState(false);
                setNotice("次の接続のときに、パターン登録の案内を出します");
              }}
            >
              パターン登録の案内を再表示する
            </button>
          )}
        </>
      )}
    </main>
  );
}
