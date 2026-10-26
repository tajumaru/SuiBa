import React, { useEffect, useRef, useState } from "react";
import { appendPatternDot } from "./patternLock.ts";

/** Geometry of the 3x3 pad, in its own 264-unit viewBox space. */
export const PAD_SIZE = 264;
const CENTERS = [44, 132, 220];
const HIT_RADIUS = 40;
const DOT_POSITIONS: ReadonlyArray<readonly [number, number]> =
  CENTERS.flatMap((y) => CENTERS.map((x) => [x, y] as const));

export type PatternPadTone = "idle" | "error" | "success";

/**
 * The finger-trace pad shared by the login screen (unlock) and
 * the enrolment dialog (draw twice). It owns only the tracing:
 * hit-testing, the skip-over rule (via patternLock) and the
 * drawn line. What a completed trace means — unlock, first
 * enrolment draw, confirmation — is the caller's business,
 * reported through onComplete; the caller clears the pad by
 * bumping resetKey and colours it through tone.
 *
 * Pointer-only by design: the token form always remains as the
 * accessible alternative, and the pad says so in its label.
 */
export function PatternPad({
  onComplete,
  onDrawStart,
  tone = "idle",
  resetKey = 0,
  disabled = false,
}: {
  onComplete: (sequence: number[]) => void;
  onDrawStart?: () => void;
  tone?: PatternPadTone;
  resetKey?: number;
  disabled?: boolean;
}) {
  const [sequence, setSequence] = useState<number[]>([]);
  const [livePoint, setLivePoint] = useState<readonly [number, number] | null>(
    null,
  );
  const drawingRef = useRef(false);
  const padRef = useRef<HTMLDivElement | null>(null);
  // The sequence also lives in a ref: pointerup must report the
  // trace as it stands at that event, even if the last move's
  // state update has not rendered yet.
  const sequenceRef = useRef<number[]>([]);
  const applySequence = (next: number[]) => {
    sequenceRef.current = next;
    setSequence(next);
  };

  useEffect(() => {
    applySequence([]);
    setLivePoint(null);
    drawingRef.current = false;
  }, [resetKey]);

  const toLocal = (clientX: number, clientY: number) => {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const scale = PAD_SIZE / rect.width;
    return [
      (clientX - rect.left) * scale,
      (clientY - rect.top) * scale,
    ] as const;
  };

  const hitDot = (point: readonly [number, number]): number => {
    for (let i = 0; i < DOT_POSITIONS.length; i++) {
      const [cx, cy] = DOT_POSITIONS[i];
      if (Math.hypot(point[0] - cx, point[1] - cy) < HIT_RADIUS) return i;
    }
    return -1;
  };

  const stroke =
    tone === "error"
      ? "#ff9c9c"
      : tone === "success"
        ? "#43dfb2"
        : "#72d1ff";
  const points = [
    ...sequence.map((i) => DOT_POSITIONS[i].join(",")),
    ...(livePoint && sequence.length ? [livePoint.join(",")] : []),
  ].join(" ");

  return (
    <div
      ref={padRef}
      className={`pattern-pad tone-${tone}`}
      role="img"
      aria-label="パターンをなぞる盤面（トークン入力でもログインできます）"
      onPointerDown={(e) => {
        if (disabled) return;
        const point = toLocal(e.clientX, e.clientY);
        if (!point) return;
        drawingRef.current = true;
        applySequence([]);
        onDrawStart?.();
        const dot = hitDot(point);
        if (dot >= 0) applySequence(appendPatternDot([], dot));
        setLivePoint(point);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drawingRef.current || disabled) return;
        const point = toLocal(e.clientX, e.clientY);
        if (!point) return;
        const dot = hitDot(point);
        if (dot >= 0)
          applySequence(appendPatternDot(sequenceRef.current, dot));
        setLivePoint(point);
      }}
      onPointerUp={() => {
        if (!drawingRef.current) return;
        drawingRef.current = false;
        setLivePoint(null);
        if (sequenceRef.current.length) onComplete([...sequenceRef.current]);
      }}
      onPointerCancel={() => {
        drawingRef.current = false;
        setLivePoint(null);
        applySequence([]);
      }}
    >
      <svg viewBox={`0 0 ${PAD_SIZE} ${PAD_SIZE}`} aria-hidden="true">
        {points && (
          <polyline
            points={points}
            fill="none"
            stroke={stroke}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.85"
          />
        )}
      </svg>
      {DOT_POSITIONS.map(([x, y], i) => (
        <span
          key={i}
          className={`pattern-dot${sequence.includes(i) ? " on" : ""}`}
          style={{ left: `${(x / PAD_SIZE) * 100}%`, top: `${(y / PAD_SIZE) * 100}%` }}
        />
      ))}
    </div>
  );
}
