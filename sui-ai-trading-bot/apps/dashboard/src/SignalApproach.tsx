import React from "react";
import type { SignalProgress } from "./signalProgress.ts";
import type { VitalState } from "./botVital.ts";

/**
 * Same hand-drawn Sui-shaped droplet silhouette as BotVitalSigns
 * (not the official Sui SVG path).
 */
const DROP_PATH =
  "M57 3 C61 22 88 47 93 75 C98 103 79 127 50 127 C21 127 2 103 7 75 C12 50 41 24 57 3 Z";
const DROP_WAVE_PATH =
  "M-5 94 C18 80 34 106 55 92 C72 81 88 82 105 92 L105 108 C74 124 26 122 -5 108 Z";

const PHASE_LABEL = {
  far: "まだ距離あり",
  approaching: "近づいてきた",
  almost: "あと一歩",
  ready: "買い条件が揃った",
} as const;

const timeText = (ms: number) =>
  new Date(ms).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * 「あと一歩ゲージ × 雫」: how close the strategy's BUY entry is, from
 * the evidence the strategy itself recorded (see signalProgress.ts).
 * The droplet swells with the bottleneck gauge's progress, trembles
 * when the entry is あと一歩, and falls when every condition holds.
 *
 * The droplet only moves while `botVital` says the bot is actually
 * live (alive / weak): stopped, safety-stopped and unknown states
 * render everything static — grey, frozen pale, or dimmed — mirroring
 * BotVitalSigns so the two displays never contradict. The swelling is
 * a symbol of the bottleneck progress, not a probability.
 */
export function SignalApproach({
  progress,
  vitalState,
}: {
  progress: SignalProgress;
  vitalState: VitalState;
}) {
  const live = vitalState === "alive" || vitalState === "weak";
  return (
    <div
      className={`signal-approach ${vitalState}`}
      aria-label="買いシグナルまでの近さ"
    >
      <div className="signal-approach-head">
        <strong>買いシグナルまで「あと一歩」</strong>
        {progress.available && (
          <span className="signal-approach-phase">
            {PHASE_LABEL[progress.phase]}
          </span>
        )}
      </div>
      {!progress.available ? (
        <small className="signal-approach-empty">
          {progress.reason === "has-position"
            ? "ポジション保有中のため、買いシグナルの接近度は表示しません（次の判断は利確・損切りの条件です）。"
            : "戦略の判定材料がまだ記録されていないため、接近度は表示できません。"}
        </small>
      ) : (
        <>
          <div className="signal-approach-scene" aria-hidden="true">
            <span className="signal-approach-pipe" />
            <span
              className={`signal-approach-drop${
                live && progress.allMet
                  ? " ready"
                  : live && progress.phase === "almost"
                    ? " tremble"
                    : ""
              }`}
            >
              <span
                className="signal-approach-drop-inner"
                style={{
                  transform: `scale(${(
                    0.55 +
                    (progress.overall / 100) * 0.75
                  ).toFixed(3)})`,
                }}
              >
                <svg viewBox="0 0 100 130">
                <defs>
                  <linearGradient
                    id="signal-approach-drop-grad"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0" stopColor="#8fc9ff" />
                    <stop offset="0.55" stopColor="#4da2ff" />
                    <stop offset="1" stopColor="#1b63d8" />
                  </linearGradient>
                  <clipPath id="signal-approach-drop-clip">
                    <path d={DROP_PATH} />
                  </clipPath>
                </defs>
                <path d={DROP_PATH} fill="url(#signal-approach-drop-grad)" />
                  <g clipPath="url(#signal-approach-drop-clip)">
                    <path d={DROP_WAVE_PATH} fill="rgba(255,255,255,0.38)" />
                  </g>
                </svg>
              </span>
            </span>
            {progress.allMet && (
              <span className="signal-approach-banner">買い条件が揃った</span>
            )}
          </div>
          <ul className="signal-approach-gauges">
            {progress.gauges.map((g) => (
              <li key={g.id} className="signal-approach-gauge">
                <span className="signal-approach-gauge-name">{g.label}</span>
                <span
                  className="signal-approach-track"
                  role="img"
                  aria-label={`${g.label} 進み具合 ${g.progress}%`}
                >
                  <span
                    className={`signal-approach-fill${g.met ? " met" : ""}`}
                    style={{ width: `${g.progress}%` }}
                  />
                </span>
                {g.met ? (
                  <span className="signal-approach-met">成立</span>
                ) : (
                  <span className="signal-approach-rest">
                    {g.remainingText}
                  </span>
                )}
                <small className="signal-approach-detail">{g.detailText}</small>
              </li>
            ))}
          </ul>
          <small className="signal-approach-note">
            戦略の最終判定（{timeText(progress.evaluatedAt)}
            ）の材料から計算しています。進み具合は各条件までの距離を目安に換算した表示で、成立の確率ではありません。条件が揃っても、実際の注文は出来高や安全条件などの別ゲートを通った場合のみ行われます。
          </small>
        </>
      )}
    </div>
  );
}
