import React, { useEffect, useState } from "react";
import { botVital } from "./botVital.ts";
import type { OperationsSnapshot } from "./operationsTypes.ts";

/** One ECG period (150 units wide); the trace repeats it and scrolls. */
const ECG_SEGMENT =
  "M0 28 H30 L40 21 L50 28 H64 L70 12 L77 41 L84 28 H102 L112 20 L122 28 H150";
const HEART_PATH =
  "M24 42 C10 32 4 24 4 16 C4 9 9 4 15 4 C19 4 23 7 24 10 C25 7 29 4 33 4 C39 4 44 9 44 16 C44 24 38 32 24 42 Z";

const ago = (seconds: number) =>
  seconds < 60
    ? `${seconds}秒前`
    : `${Math.floor(seconds / 60)}分${seconds % 60}秒前`;
const inText = (seconds: number) =>
  seconds < 60
    ? `あと${seconds}秒`
    : `あと${Math.floor(seconds / 60)}分${seconds % 60}秒`;

/**
 * A heartbeat for the bot: a heart that beats, an ECG trace, and the live
 * evidence behind them (fetch in progress, seconds since the last analysis,
 * countdown to the next fetch). The visuals follow `botVital`, which mirrors
 * the operation summary's evidence, and the readout text always states the
 * same facts without relying on the animation.
 */
export function BotVitalSigns({
  data,
  stale,
}: {
  data: OperationsSnapshot;
  stale: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const vital = botVital(data, stale, now);
  const beatStyle = vital.beatSeconds
    ? { animationDuration: `${vital.beatSeconds}s` }
    : undefined;
  const facts: string[] = [];
  if (vital.fetching) facts.push("いま市場データを取得中…");
  if (vital.lastAnalysisSecondsAgo != null)
    facts.push(`最終分析 ${ago(vital.lastAnalysisSecondsAgo)}`);
  if (
    vital.nextFetchSecondsIn != null &&
    (vital.state === "alive" || vital.state === "weak")
  )
    facts.push(`次回取得まで ${inText(vital.nextFetchSecondsIn)}`);
  if (vital.heartbeatSecondsAgo != null)
    facts.push(`Workerの心拍信号 ${ago(vital.heartbeatSecondsAgo)}`);

  return (
    <div className={`bot-vital ${vital.state}`} aria-label="Botの鼓動">
      <div className="bot-vital-heart" aria-hidden="true">
        {vital.beatSeconds != null && (
          <span className="bot-vital-ring" style={beatStyle} />
        )}
        <svg
          viewBox="0 0 48 48"
          className="bot-vital-heart-icon"
          style={beatStyle}
        >
          <path d={HEART_PATH} />
        </svg>
      </div>
      <svg
        viewBox="0 0 300 48"
        className="bot-vital-ecg"
        aria-hidden="true"
        preserveAspectRatio="none"
      >
        {vital.ecg === "flat" ? (
          <line x1="0" y1="28" x2="300" y2="28" className="bot-ecg-flat" />
        ) : (
          <g
            className={`bot-ecg-wave ${vital.ecg}`}
            style={vital.fetching ? { animationDuration: "0.75s" } : undefined}
          >
            {[0, 150, 300, 450].map((dx) => (
              <path key={dx} d={ECG_SEGMENT} transform={`translate(${dx} 0)`} />
            ))}
          </g>
        )}
      </svg>
      <div className="bot-vital-readout">
        <strong>{vital.label}</strong>
        {facts.length > 0 && <small>{facts.join(" · ")}</small>}
      </div>
    </div>
  );
}
