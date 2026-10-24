import React from "react";
import type { BotVital } from "./botVital.ts";

/**
 * Hand-drawn droplet silhouette in the shape of the Sui mark: upright,
 * tip leaning slightly right, with a wave cut across the lower body.
 * (Not the official Sui SVG path — drawn for this component so no new
 * asset dependency is needed.)
 */
const DROP_PATH =
  "M57 3 C61 22 88 47 93 75 C98 103 79 127 50 127 C21 127 2 103 7 75 C12 50 41 24 57 3 Z";
const DROP_WAVE_PATH =
  "M-5 94 C18 80 34 106 55 92 C72 81 88 82 105 92 L105 108 C74 124 26 122 -5 108 Z";

/**
 * Decorative candle row: fixed heights/colours, NOT market data. The
 * newest (rightmost) candle is the one the droplet "births" each cycle.
 */
const PAST_CANDLES: { height: number; up: boolean }[] = [
  { height: 22, up: true },
  { height: 15, up: false },
  { height: 28, up: true },
  { height: 36, up: true },
  { height: 26, up: false },
  { height: 40, up: true },
];
const NEW_CANDLE_HEIGHT = 31;

const ago = (seconds: number) =>
  seconds < 60
    ? `${seconds}秒前`
    : `${Math.floor(seconds / 60)}分${seconds % 60}秒前`;
const inText = (seconds: number) =>
  seconds < 60
    ? `あと${seconds}秒`
    : `あと${Math.floor(seconds / 60)}分${seconds % 60}秒`;
const overdueText = (seconds: number) =>
  seconds < 1 ? "取得予定時刻を超過" : `取得予定時刻を${seconds}秒超過`;

/**
 * Presentational vital signs: renders the `BotVital` computed by
 * `botVital.ts` from the operations snapshot — a Sui-shaped droplet that
 * falls and births the newest candle of a decorative candle row, plus
 * the evidence behind the state (fetch in progress, seconds since the
 * last analysis, next-fetch countdown or overdue notice). The droplet
 * and candles are symbols of the state, not measurements of price or
 * activity frequency: the candle heights are a fixed decorative pattern
 * and carry no market data. Nothing moves while the bot is stopped.
 */
export function BotVitalSigns({ vital }: { vital: BotVital }) {
  const live = vital.state === "alive" || vital.state === "weak";
  // One animation cycle per "beat", stretched so a fall-and-birth reads
  // clearly; an in-progress fetch runs the cycle at double speed.
  const cycleSeconds =
    vital.beatSeconds != null
      ? vital.beatSeconds * 2.4 * (vital.fetching ? 0.5 : 1)
      : null;
  const sceneStyle =
    cycleSeconds != null
      ? ({ "--vital-cycle": `${cycleSeconds}s` } as React.CSSProperties)
      : undefined;
  const facts: string[] = [];
  if (vital.fetching) facts.push("いま市場データを取得中…");
  if (vital.lastAnalysisSecondsAgo != null)
    facts.push(`最終分析 ${ago(vital.lastAnalysisSecondsAgo)}`);
  if (live && vital.nextFetchSecondsIn != null)
    facts.push(`次回取得まで ${inText(vital.nextFetchSecondsIn)}`);
  if (live && vital.nextFetchOverdueSeconds != null)
    facts.push(overdueText(vital.nextFetchOverdueSeconds));
  if (vital.heartbeatSecondsAgo != null)
    facts.push(`Workerの心拍信号 ${ago(vital.heartbeatSecondsAgo)}`);

  return (
    <div
      className={`bot-vital ${vital.state}`}
      aria-label="Botの雫とローソク足"
    >
      <div className="bot-vital-scene" style={sceneStyle} aria-hidden="true">
        {cycleSeconds != null && (
          <>
            <span className="bot-vital-drop">
              <svg viewBox="0 0 100 130">
                <defs>
                  <linearGradient
                    id="bot-vital-drop-grad"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0" stopColor="#8fc9ff" />
                    <stop offset="0.55" stopColor="#4da2ff" />
                    <stop offset="1" stopColor="#1b63d8" />
                  </linearGradient>
                  <clipPath id="bot-vital-drop-clip">
                    <path d={DROP_PATH} />
                  </clipPath>
                </defs>
                <path d={DROP_PATH} fill="url(#bot-vital-drop-grad)" />
                <g clipPath="url(#bot-vital-drop-clip)">
                  <path d={DROP_WAVE_PATH} fill="rgba(255,255,255,0.38)" />
                  <ellipse
                    cx="66"
                    cy="52"
                    rx="9"
                    ry="17"
                    fill="rgba(255,255,255,0.4)"
                    transform="rotate(-18 66 52)"
                  />
                </g>
              </svg>
            </span>
            <span className="bot-vital-ripple" />
            <span className="bot-vital-ripple delay" />
          </>
        )}
        <div className="bot-vital-candles">
          {PAST_CANDLES.map((c, i) => (
            <span
              key={i}
              className={`bot-vital-candle ${c.up ? "up" : "down"}`}
              style={{ height: `${c.height}px` }}
            />
          ))}
          <span
            className={`bot-vital-candle up new${cycleSeconds != null ? " born" : ""}`}
            style={{ height: `${NEW_CANDLE_HEIGHT}px` }}
          />
        </div>
        <span className="bot-vital-floor" />
      </div>
      <div className="bot-vital-readout">
        <strong>{vital.label}</strong>
        {facts.length > 0 && <small>{facts.join(" · ")}</small>}
        <small className="bot-vital-note">
          雫とローソク足は稼働状態の模式表示です。ローソク足の高さ・色は装飾で、実際の価格や取得・分析の頻度を表すものではありません。
        </small>
      </div>
    </div>
  );
}
