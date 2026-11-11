import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "./AgentNarration.tsx";

/**
 * The boot sequence shown once per login session, over the
 * shell while it loads (approved prototype: the plain version —
 * lines fade in one by one over the login grid, a blinking
 * cursor on the last line, tap to skip, a hard cap so it can
 * never trap the user). Every line is a fact the app already
 * knows: the token was verified to get here, the api/pair/bot
 * lines resolve from the first snapshot and update in place
 * while the sequence runs.
 *
 * The full sequence plays on the first visit of a browser
 * session. A repeat visit in the same session (marked in
 * sessionStorage, so nothing persists across sessions) shows
 * the logo with every line already on and finishes in a
 * fraction of the time — the drama is for first visits, the
 * phone re-open should be quick. Storage trouble (private
 * mode, disabled storage) fails open to the full sequence.
 */

export type BootApiState = "pending" | "ok" | "error";
export type BootBotState =
  | "unknown"
  | "running"
  | "stopped"
  | "emergency"
  | "error";

export interface BootLine {
  key: string;
  label: string;
  dots: string;
  value: string;
  tone: "ok" | "plain" | "tag" | "alert" | "dim";
}

export function bootLines(input: {
  pairLabel: string;
  api: BootApiState;
  bot: BootBotState;
  /** The character's user-chosen name, when one is set. */
  agentName?: string;
}): BootLine[] {
  return [
    { key: "token", label: "token", dots: "............", value: "OK", tone: "ok" },
    {
      key: "api",
      label: "api link",
      dots: ".........",
      value: input.api === "ok" ? "OK" : input.api === "error" ? "届かない" : "確認中",
      tone: input.api === "ok" ? "ok" : input.api === "error" ? "alert" : "dim",
    },
    { key: "pair", label: "pair", dots: ".............", value: input.pairLabel, tone: "plain" },
    { key: "mode", label: "mode", dots: ".............", value: "[ PAPER ]", tone: "tag" },
    {
      key: "bot",
      label: "bot",
      dots: "..............",
      value:
        input.bot === "running"
          ? "運用中"
          : input.bot === "stopped"
            ? "停止中"
            : input.bot === "emergency"
              ? "緊急停止中"
              : input.bot === "error"
                ? "安全停止中"
                : "確認中",
      tone:
        input.bot === "running"
          ? "ok"
          : input.bot === "emergency" || input.bot === "error"
            ? "alert"
            : input.bot === "unknown"
              ? "dim"
              : "plain",
    },
    {
      key: "character",
      label: "character",
      dots: "........",
      value: input.agentName ? `${input.agentName} ready` : "ready",
      tone: "ok",
    },
  ];
}

const LINE_MS = 200;
const FIRST_MS = 150;
const HOLD_MS = 550;
const FADE_MS = 300;
const CAP_MS = 3500;
/** Repeat visits hold only this long before the usual fade. */
const FAST_HOLD_MS = 250;

export const BOOT_SEEN_KEY = "potario-boot-seen";

type BootStorage = Pick<Storage, "getItem" | "setItem">;

function defaultBootStorage(): BootStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** True when this browser session has already seen a boot. */
export function isRepeatBootVisit(
  storage: BootStorage | null = defaultBootStorage(),
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(BOOT_SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

/** Record that this browser session has seen a boot. */
export function markBootSeen(
  storage: BootStorage | null = defaultBootStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(BOOT_SEEN_KEY, "1");
  } catch {
    // Storage can refuse (private mode, quotas); the next visit
    // then simply gets the full sequence again.
  }
}

export function BootScreen({
  pairLabel,
  api,
  bot,
  onDone,
  agentName = "",
}: {
  pairLabel: string;
  api: BootApiState;
  bot: BootBotState;
  onDone: () => void;
  agentName?: string;
}) {
  const lines = bootLines({ pairLabel, api, bot, agentName });
  const reducedMotion = usePrefersReducedMotion();
  const [repeat] = useState(() => isRepeatBootVisit());
  const [step, setStep] = useState(
    reducedMotion || repeat ? lines.length : 0,
  );
  const [leaving, setLeaving] = useState(false);
  const doneRef = useRef(false);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setStep(lines.length);
    setLeaving(true);
    window.setTimeout(onDone, reducedMotion ? 0 : FADE_MS);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    if (!repeat) markBootSeen();
    if (reducedMotion) {
      const hold = window.setTimeout(() => finishRef.current(), 500);
      return () => window.clearTimeout(hold);
    }
    if (repeat) {
      // Fast path: logo and lines are already on screen; hold
      // briefly, then finish through the normal fade. The hard
      // cap stays so this path can never trap the user either.
      const timers = [
        window.setTimeout(() => finishRef.current(), FAST_HOLD_MS),
        window.setTimeout(() => finishRef.current(), CAP_MS),
      ];
      return () => timers.forEach((t) => window.clearTimeout(t));
    }
    const timers: number[] = [];
    for (let i = 1; i <= lines.length; i++) {
      timers.push(window.setTimeout(() => setStep(i), FIRST_MS + i * LINE_MS));
    }
    timers.push(
      window.setTimeout(
        () => finishRef.current(),
        FIRST_MS + lines.length * LINE_MS + HOLD_MS,
      ),
    );
    // Hard cap: whatever the data does, the boot never traps.
    timers.push(window.setTimeout(() => finishRef.current(), CAP_MS));
    return () => timers.forEach((t) => window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedMotion, repeat]);

  return (
    <div
      className={`boot-screen${leaving ? " leaving" : ""}`}
      role="status"
      aria-label="起動中"
      onClick={() => finishRef.current()}
    >
      <div className="boot-inner">
        <p className="boot-logo">
          POTA<span>RIO</span>
        </p>
        <p className="boot-ver">PAPER TRADING TERMINAL</p>
        <div className="boot-lines">
          {lines.map((line, i) => (
            <p key={line.key} className={`boot-line${i < step ? " on" : ""}`}>
              &gt; {line.label} <span className="boot-dots">{line.dots}</span>{" "}
              <span className={`boot-value ${line.tone}`}>{line.value}</span>
              {line.key === "character" && <span className="boot-cursor" />}
            </p>
          ))}
        </div>
        <p className="boot-skip">TAP TO SKIP</p>
      </div>
    </div>
  );
}
