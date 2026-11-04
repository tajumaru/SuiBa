import { useEffect, useMemo, useState } from "react";
import type { AgentPose } from "./agentNarration.ts";
import { highlightLabel, type Highlight } from "./highlightStore.ts";
import imgNormal from "./assets/agent-white-normal.jpg";
import imgPoint from "./assets/agent-white-point.jpg";
import imgPointSmile from "./assets/agent-white-point-smile.jpg";
import imgBlueLine from "./assets/agent-blue-line.jpg";
import imgPenNormal from "./assets/agent-pen-normal.jpg";
import imgPenPoint from "./assets/agent-pen-point.jpg";
import imgPenPointSmile from "./assets/agent-pen-point-smile.jpg";
import imgPenBlueLine from "./assets/agent-pen-blue-line.jpg";
import imgFizhNormal from "./assets/agent-fizh-normal.jpg";
import imgFizhPoint from "./assets/agent-fizh-point.jpg";
import imgFizhPointSmile from "./assets/agent-fizh-point-smile.jpg";
import imgFizhBlueLine from "./assets/agent-fizh-blue-line.jpg";
import { useAgentCharacter } from "./agentCharacter.ts";

// The replay renders the pose artwork itself rather than
// importing the feed's avatar component: the feed imports this
// replay, and the module graph must stay acyclic. Poses outside
// the map fall back to the normal artwork. The selected
// character's set is used, so a replay watched as ぺんちゃん
// replays with ぺんちゃん on stage.
const POSE_IMAGE: Partial<Record<AgentPose, string>> = {
  normal: imgNormal,
  point: imgPoint,
  pointSmile: imgPointSmile,
  buyLine: imgBlueLine,
};
const PEN_POSE_IMAGE: Partial<Record<AgentPose, string>> = {
  normal: imgPenNormal,
  point: imgPenPoint,
  pointSmile: imgPenPointSmile,
  buyLine: imgPenBlueLine,
};
const FIZH_POSE_IMAGE: Partial<Record<AgentPose, string>> = {
  normal: imgFizhNormal,
  point: imgFizhPoint,
  pointSmile: imgFizhPointSmile,
  buyLine: imgFizhBlueLine,
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/**
 * Replays one bookmarked highlight: the feed entries leading
 * into the moment appear one by one, the character strikes the
 * pose of each beat, and the price path recorded at the time
 * draws itself underneath. It is a re-enactment from the stored
 * record — labelled 再演 — made to be watched again or captured
 * with the OS screen recorder for sharing.
 */
const POSE_BY_KIND: Record<string, AgentPose> = {
  trade: "pointSmile",
  watchHit: "pointSmile",
  nearMiss: "point",
  priceLineReached: "buyLine",
  sellLine: "point",
  priceLine: "buyLine",
  alert: "point",
};

const STEP_MS = 1400;

export function HighlightReplay({
  highlight,
  onClose,
}: {
  highlight: Highlight;
  onClose: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const character = useAgentCharacter();
  const poseImages =
    character === "pen"
      ? PEN_POSE_IMAGE
      : character === "fizh"
        ? FIZH_POSE_IMAGE
        : POSE_IMAGE;
  const poseFallback =
    character === "pen"
      ? imgPenNormal
      : character === "fizh"
        ? imgFizhNormal
        : imgNormal;
  const total = highlight.entries.length;
  const [step, setStep] = useState(reduced ? total - 1 : 0);
  const [playing, setPlaying] = useState(!reduced);
  useEffect(() => {
    if (!playing) return;
    if (step >= total - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, step, total]);
  const current = highlight.entries[step];
  const pose: AgentPose =
    (current && POSE_BY_KIND[current.kind]) || "normal";
  const spark = useMemo(() => {
    const prices = highlight.prices;
    if (prices.length < 2) return null;
    const min = Math.min(...prices),
      max = Math.max(...prices),
      span = max - min || 1;
    const points = prices
      .map(
        (p, i) =>
          `${((i / (prices.length - 1)) * 260).toFixed(1)},${(40 - ((p - min) / span) * 36).toFixed(1)}`,
      )
      .join(" ");
    const frac = total <= 1 ? 1 : step / (total - 1),
      mi = frac * (prices.length - 1),
      lo = Math.floor(mi),
      hi = Math.min(prices.length - 1, lo + 1),
      mv = prices[lo] + (prices[hi] - prices[lo]) * (mi - lo);
    return {
      points,
      marker: {
        x: frac * 260,
        y: 40 - ((mv - min) / span) * 36,
      },
    };
  }, [highlight.prices, step, total]);
  const time = (at: number) =>
    new Date(at).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <div className="highlight-replay" role="dialog" aria-label="ハイライト再演">
      <div className="highlight-replay-head">
        <span className="agent-feed-entry-tag">{highlightLabel(highlight)}</span>
        <span className="highlight-replay-title">
          {new Date(highlight.at).toLocaleDateString("ja-JP")}{" "}
          {time(highlight.at)} の瞬間（再演）
        </span>
        <button type="button" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </div>
      <div className="highlight-replay-stage">
        <img src={poseImages[pose] ?? poseFallback} alt="" />
        <div className="highlight-replay-entries">
          {highlight.entries.slice(0, step + 1).map((e) => (
            <p key={e.id} className="highlight-replay-entry">
              <time>{time(e.at)}</time>
              {e.id === highlight.id ? (
                <strong>{e.text}</strong>
              ) : (
                <span>{e.text}</span>
              )}
            </p>
          ))}
        </div>
      </div>
      {spark && (
        <svg
          className="highlight-replay-spark"
          viewBox="0 0 260 48"
          aria-label="その頃の価格の流れ"
        >
          <polyline points={spark.points} fill="none" />
          <circle cx={spark.marker.x} cy={spark.marker.y} r="3.5" />
        </svg>
      )}
      <div className="highlight-replay-controls">
        <button
          type="button"
          onClick={() => {
            setStep(0);
            setPlaying(true);
          }}
        >
          もう一度
        </button>
        <span className="highlight-replay-progress">
          {step + 1} / {total}
        </span>
        <button type="button" onClick={onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
