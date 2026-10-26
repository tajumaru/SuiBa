import React, { useState } from "react";
import { PatternPad, type PatternPadTone } from "./PatternPad.tsx";
import {
  enrollPattern,
  isDismissed,
  isEnrolled,
  isPatternLockSupported,
  isValidPattern,
  patternKey,
  setDismissed,
} from "./patternLock.ts";

/**
 * The one-time offer, shown at the top of the app after a token
 * login, to enrol this device for pattern unlock (patternLock).
 * It stays until the reader enrols, puts it off, or dismisses
 * it for good; a dismissed offer can be brought back from the
 * login screen. Enrolment itself is a small dialog: draw the
 * pattern twice, and the current session's token is encrypted
 * under it and stored on this device only.
 */

export interface EnrollmentPort {
  supported(): boolean;
  enrolled(): boolean;
  dismissed(): boolean;
  dismiss(): void;
  enroll(pattern: number[], token: string): Promise<void>;
}

const defaultPort: EnrollmentPort = {
  supported: () => isPatternLockSupported(),
  enrolled: () => isEnrolled(),
  dismissed: () => isDismissed(),
  dismiss: () => setDismissed(),
  enroll: (pattern, token) => enrollPattern(pattern, token),
};

type Step = "first" | "confirm" | "done";

export function PatternEnrollmentOffer({
  token,
  port = defaultPort,
}: {
  token: string;
  port?: EnrollmentPort;
}) {
  const [visible, setVisible] = useState<boolean>(
    () => port.supported() && !port.enrolled() && !port.dismissed(),
  );
  const [step, setStep] = useState<Step | null>(null);
  const [first, setFirst] = useState<number[] | null>(null);
  const [padReset, setPadReset] = useState(0);
  const [padTone, setPadTone] = useState<PatternPadTone>("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!visible) return null;

  const resetPad = (tone: PatternPadTone = "idle") => {
    setPadTone(tone);
    setPadReset((n) => n + 1);
  };

  async function handleComplete(sequence: number[]) {
    if (step === "first") {
      if (!isValidPattern(sequence)) {
        setMessage("短すぎるみたい。4つ以上の点をつないでね");
        resetPad("error");
        return;
      }
      setFirst(sequence);
      setStep("confirm");
      setMessage("確認のため、もう一度同じパターンをなぞってね");
      resetPad();
      return;
    }
    if (step === "confirm" && first) {
      if (patternKey(sequence) !== patternKey(first)) {
        setMessage("1回目と違うみたい。最初からやり直してね");
        setFirst(null);
        setStep("first");
        resetPad("error");
        return;
      }
      try {
        await port.enroll(first, token);
        setStep("done");
        setMessage(
          "登録しました。次にこの端末で開くときは、このパターンで入れます",
        );
        resetPad("success");
      } catch {
        setMessage("登録できませんでした。この端末では使えないみたい");
        setFirst(null);
        setStep("first");
        resetPad("error");
      }
    }
  }

  return (
    <>
      <section className="pattern-offer" aria-label="パターン登録の案内">
        <p>
          この端末では、次回から<strong>パターン</strong>
          で入れるようにできます（簡易ロック）
        </p>
        <div className="pattern-offer-actions">
          <button
            type="button"
            onClick={() => {
              setStep("first");
              setFirst(null);
              setMessage("パターンを登録してね（4つ以上の点）");
              resetPad();
            }}
          >
            パターンを登録する
          </button>
          <button type="button" onClick={() => setVisible(false)}>
            今はしない
          </button>
          <button
            type="button"
            onClick={() => {
              port.dismiss();
              setVisible(false);
            }}
          >
            今後表示しない
          </button>
        </div>
      </section>
      {step !== null && (
        <div className="pattern-dialog-backdrop">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="パターンの登録"
            className="pattern-dialog"
          >
            <h3>パターンの登録</h3>
            <p className="pattern-dialog-note">
              登録すると、この端末のブラウザに、トークンをパターンで暗号化して保存します。パターンを忘れても、トークンで入り直せます。
            </p>
            <p className="pattern-dialog-message" role="status">
              {message}
            </p>
            {step !== "done" ? (
              <PatternPad
                onComplete={(seq) => void handleComplete(seq)}
                tone={padTone}
                resetKey={padReset}
              />
            ) : null}
            <div className="pattern-dialog-actions">
              {step === "done" ? (
                <button
                  type="button"
                  onClick={() => {
                    setStep(null);
                    setVisible(false);
                  }}
                >
                  閉じる
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setStep(null);
                    setFirst(null);
                  }}
                >
                  やめる
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
