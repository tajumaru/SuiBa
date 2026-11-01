import React, { useEffect, useRef, useState } from "react";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import { botVital } from "./botVital.ts";
import type { ErrorShout } from "./errorShout.ts";
import { agentDisplayName } from "./agentName.ts";
import {
  startListening,
  voiceRecognitionCtor,
  type VoiceSession,
} from "./voiceInput.ts";
import {
  createAgentSpeaker,
  isSpeechSupported,
  loadAgentVoice,
  saveAgentVoice,
  type AgentSpeaker,
} from "./voiceSpeech.ts";
import {
  commandSuggestions,
  isCommandText,
  runChatCommand,
} from "./chatCommands.ts";
import {
  advanceNarration,
  agentPose,
  BUY_CELEBRATION_MS,
  CELEBRATION_FRESH_MS,
  currentConditionChips,
  currentWatch,
  currentWatchScore,
  findNewBuyEntry,
  isBuyTradeEntry,
  trimNarrationEntries,
  type AgentPose,
  type NarrationEntry,
  type NarrationState,
} from "./agentNarration.ts";
import imgNormal from "./assets/agent-white-normal.jpg";
import imgPoint from "./assets/agent-white-point.jpg";
import imgPointSmile from "./assets/agent-white-point-smile.jpg";
import imgSleep from "./assets/agent-white-sleep.jpg";
import imgLaptop from "./assets/agent-white-laptop.jpg";
import imgLaptopTyping from "./assets/agent-white-laptop-typing.jpg";
import imgScream from "./assets/agent-white-scream.jpg";
import imgListen from "./assets/agent-white-listen.jpg";
import imgBlueLine from "./assets/agent-blue-line.jpg";
import imgHard from "./assets/agent-hard.jpg";
import imgHardGuitar from "./assets/agent-hard-guitar.jpg";
import imgHardGuitar2 from "./assets/agent-hard-guitar-2.jpg";
import imgHardPoint from "./assets/agent-hard-point.jpg";
import imgHardPointSmile from "./assets/agent-hard-point-smile.jpg";
import { persistNarration, restoreNarration } from "./narrationStorage.ts";
import {
  agentReply,
  followUpChips,
  orderedChips,
  proactivePrompt,
  proactivePromptDue,
  type AgentChatContext,
  type ChatTopic,
} from "./agentChat.ts";

/**
 * The display's reduced-motion preference, read synchronously on
 * first render when a media query list is available (tests stub
 * it) and kept current through its change events. Components use
 * it to leave animated celebration marks out entirely under
 * reduce; style.css independently defines every animation only
 * under no-preference, so the two layers agree.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    )
      return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

const POSE_IMAGE: Record<AgentPose, string> = {
  normal: imgNormal,
  point: imgPoint,
  pointSmile: imgPointSmile,
  sleep: imgSleep,
  laptop: imgLaptop,
  buyLine: imgBlueLine,
};
const POSE_LABEL: Record<AgentPose, string> = {
  normal: "様子を見ています",
  point: "条件が近づいています",
  pointSmile: "売買を記録しました",
  sleep: "止まっています",
  laptop: "様子を見ています",
  buyLine: "ラインに接近中",
};

/**
 * The avatar artwork for the current pose. Only the laptop pose has
 * a second frame — the same scene with the near hand's index finger
 * raised — stacked on top of the base frame; style.css flips the
 * two in a two-frame typing loop (about 0.26s per frame) purely with
 * CSS keyframes, and only when reduced motion is not requested.
 * Under prefers-reduced-motion the second frame rests invisible,
 * so the laptop pose is the still base frame, like every other
 * pose's single image.
 *
 * While the saved settings are the hard-mode preset, the working
 * poses wear the hard artwork instead: the normal pose becomes the
 * sunglasses-and-mohawk portrait, the laptop pose becomes the
 * Sui-blue guitar pair (playing / strumming arm raised), flipped
 * by the same typing loop, and the two pointing poses get their
 * own hard portraits (running time is mostly spent pointing, so
 * leaving them white hid the mode entirely). Sleep, the blue line
 * crowd and the scream keep their own artwork — those are
 * separate states, not the working look.
 */
export function AgentAvatarArtwork({
  pose,
  hardMode = false,
}: {
  pose: AgentPose;
  hardMode?: boolean;
}) {
  if (hardMode && pose === "normal") return <img src={imgHard} alt="" />;
  if (hardMode && pose === "point") return <img src={imgHardPoint} alt="" />;
  if (hardMode && pose === "pointSmile")
    return <img src={imgHardPointSmile} alt="" />;
  if (hardMode && pose === "laptop")
    return (
      <>
        <img src={imgHardGuitar} alt="" />
        <img
          className="agent-avatar-typing"
          src={imgHardGuitar2}
          alt=""
        />
      </>
    );
  return (
    <>
      <img src={POSE_IMAGE[pose]} alt="" />
      {pose === "laptop" && (
        <img className="agent-avatar-typing" src={imgLaptopTyping} alt="" />
      )}
    </>
  );
}

/**
 * Pill dot tone per pose, in the dashboard's usual state colours:
 * the laptop pose (awake at the desk, watching) burns green, the
 * pointing poses (a condition just clicked, or the hunt closing in)
 * burn gold, and the sleeping / unconfirmed poses stay grey.
 */
const AVATAR_DOT_TONE: Record<AgentPose, "run" | "near" | "stop" | "line"> = {
  normal: "stop",
  point: "near",
  pointSmile: "near",
  sleep: "stop",
  laptop: "run",
  buyLine: "line",
};

/**
 * The narration character as a round avatar at the top centre of
 * the app (main.tsx renders it on every tab): the pose artwork
 * clipped to a circle and gently bobbing, with the
 * pose's status label — the same POSE_LABEL the feed stage used to
 * show — in a pill underneath. The detailed expression overlay of
 * the old in-feed stage (a Zzz stream, a snot bubble, fingertip
 * stars positioned on the artwork) does not fit a 76px circle, so
 * the avatar keeps only two coarse marks: a floating "Zzz" while
 * asleep and a twinkling star while pointing, drawn as plain spans
 * keyed to the pose-* class in style.css. The artwork itself is
 * decorative (the pill carries the status text), so the circle is
 * aria-hidden. The dock is sticky (see .agent-avatar-dock in
 * style.css): it rests half over the header's bottom edge and
 * then stays at the top of the viewport while the page scrolls.
 * Motion is defined only under prefers-reduced-motion:
 * no-preference in style.css; under reduce everything rests
 * still and the marks stay as faint marks.
 */
/**
 * The burst marks of a buy celebration, in the approved flashy
 * arrangement: gold stars and pale-blue notes scattered around the
 * circle. They exist only while celebrating and only when motion
 * is allowed — under reduced motion the celebration is the still
 * smile and the gold pill alone, so the marks are never rendered.
 */
const AVATAR_BURST_MARKS = [
  { className: "s1", mark: "✦" },
  { className: "s2", mark: "✦" },
  { className: "s3", mark: "✦" },
  { className: "n1", mark: "♪" },
  { className: "n2", mark: "♪" },
  { className: "s4", mark: "✦" },
  { className: "s5", mark: "✦" },
  { className: "n3", mark: "♪" },
] as const;

/**
 * While `celebrating`, the avatar borrows the smile artwork
 * whatever the derived pose is, hops once and throws the burst
 * marks (motion permitting), and the pill turns gold with
 * 「買えた！」. The override is render-local: the feed keeps
 * reporting the pose derived from the records, so when the
 * celebration ends the avatar falls back to exactly that pose.
 *
 * An error shout (see errorShout.ts) outranks even the
 * celebration: the avatar swaps to the dedicated scream artwork
 * — the same character in a Munch-style pose, both hands with
 * fingers pressed to its cheeks, wide hollow eyes and an open
 * oval mouth — shakes once, and calls out the short fixed line
 * in a speech bubble while the pill carries the state label in
 * alert colours. The scream and bubble stay for as long as the
 * error state does; the shake replays when the kind of error
 * changes (the avatar remounts on the kind key). Under reduced
 * motion there is no shake or pop: the face, the bubble and the
 * pill still change.
 */
export function AgentHeaderAvatar({
  pose,
  celebrating = false,
  shout = null,
  hardMode = false,
  agentName = "",
  onRename,
  listening = false,
  speaking = false,
}: {
  pose: AgentPose;
  celebrating?: boolean;
  shout?: ErrorShout | null;
  /** Voice recognition is live in the chat: the DJ artwork
   * (Sui-blue headphones, one cup lifted) replaces the pose.
   * Shouts and the buy celebration outrank it. */
  listening?: boolean;
  /** A spoken reply is playing: the pointing smile shows with
   * a 喋ってる… pill. Listening, shouts and celebrations
   * outrank it. */
  speaking?: boolean;
  /** The character's user-chosen name ("" shows as キャラ). */
  agentName?: string;
  /** When set, tapping the avatar opens the rename editor and
   * saving calls this with the raw input (sanitised upstream). */
  onRename?: (name: string) => void;
  /** The saved settings are the hard-mode preset: the working
   * poses wear the hard artwork, and on the base poses (normal /
   * laptop) the pill says so too — the pointing poses keep their
   * factual state label. Shouts and celebrations outrank it. */
  hardMode?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  // While the page is scrolled, the sticky dock rides over the
  // operation bar and the ticker: shrink the avatar and fold
  // the status pill away so the character never covers the
  // state text or the price (the shout bubble stays). Hysteresis
  // keeps the boundary from flickering.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      setStuck((prev) => {
        const y = window.scrollY;
        return prev ? y > 80 : y > 140;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const shouting = shout !== null;
  const shownPose: AgentPose = shouting
    ? "normal"
    : celebrating
      ? "pointSmile"
      : pose;
  const animated = celebrating && !reducedMotion && !shouting;
  const artworkHard = hardMode && !shouting && !celebrating;
  const hardShown =
    artworkHard && (shownPose === "normal" || shownPose === "laptop");
  return (
    <div className={`agent-avatar-dock${stuck ? " stuck" : ""}`}>
      <div
        key={shout ? shout.kind : "calm"}
        className={`agent-avatar pose-${shownPose}${animated ? " celebrating" : ""}${shouting ? " shouting" : ""}`}
        data-pose={shownPose}
        aria-hidden="true"
      >
        <div className="agent-avatar-bob">
          {shouting ? (
            <img className="agent-avatar-scream" src={imgScream} alt="" />
          ) : listening && !celebrating ? (
            <img className="agent-avatar-listen" src={imgListen} alt="" />
          ) : speaking && !celebrating ? (
            <AgentAvatarArtwork pose="pointSmile" hardMode={artworkHard} />
          ) : (
            <AgentAvatarArtwork pose={shownPose} hardMode={artworkHard} />
          )}
        </div>
        <span className="agent-avatar-zzz">Zzz</span>
        <span className="agent-avatar-star">✦</span>
        {shouting && (
          <span className="agent-avatar-bubble">{shout.message}</span>
        )}
        {animated && (
          <span className="agent-avatar-burst">
            {AVATAR_BURST_MARKS.map((m) => (
              <span key={m.className} className={m.className}>
                {m.mark}
              </span>
            ))}
          </span>
        )}
        {shownPose === "buyLine" && !reducedMotion && (
          <span className="agent-avatar-petals" aria-hidden="true">
            <span className="p1" />
            <span className="p2" />
            <span className="p3" />
            <span className="p4" />
          </span>
        )}
      </div>
      <p
        className={`agent-avatar-pill${celebrating && !shouting ? " celebrate" : ""}${shouting ? " shout" : ""}${shownPose === "buyLine" && !shouting && !celebrating ? " line" : ""}`}
        role="status"
      >
        <span
          className={
            shouting
              ? "agent-avatar-dot shout"
              : `agent-avatar-dot tone-${AVATAR_DOT_TONE[shownPose]}`
          }
          aria-hidden="true"
        />
        {shouting
          ? shout.label
          : celebrating
            ? "買えた！"
            : listening
              ? "聞いてる…"
              : speaking
                ? "喋ってる…"
                : hardShown
                  ? "ハードモード中"
                  : POSE_LABEL[shownPose]}
      </p>
      {onRename && (
        <button
          type="button"
          className="agent-avatar-tap"
          aria-label={`${agentDisplayName(agentName)}の名前を変える`}
          aria-expanded={renameOpen}
          onClick={() => {
            setRenameDraft(agentName);
            setRenameOpen((v) => !v);
          }}
        >
          <span className="agent-avatar-edit-badge" aria-hidden="true">
            ✎
          </span>
        </button>
      )}
      {onRename && renameOpen && (
        <form
          className="agent-rename"
          onSubmit={(e) => {
            e.preventDefault();
            onRename(renameDraft);
            setRenameOpen(false);
          }}
        >
          <label>
            キャラの名前
            <input
              type="text"
              value={renameDraft}
              maxLength={20}
              placeholder="キャラ"
              aria-label="キャラの名前"
              onChange={(e) => setRenameDraft(e.target.value)}
            />
          </label>
          <div className="agent-rename-actions">
            <button type="submit">保存</button>
            <button
              type="button"
              onClick={() => {
                onRename("");
                setRenameOpen(false);
              }}
            >
              元に戻す
            </button>
            <button type="button" onClick={() => setRenameOpen(false)}>
              やめる
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const timeText = (at: number) =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(at));

/**
 * The agent narration feed, shown on its own tab (the default view
 * after login). A white dome character (five fixed poses) narrates the bot's
 * activity in a chat-style timeline. Every entry is generated by the
 * pure functions in agentNarration.ts from the worker's real records
 * (operation events, candidate audits, decision evidence) — the
 * component itself invents nothing, and when the display goes stale
 * the feed stops advancing, just like the vital signs.
 *
 * The character itself no longer lives in this panel: it rides
 * at the top of the app as a round avatar (AgentHeaderAvatar) on
 * every tab, staying in view while the page scrolls, and this
 * feed — the one place that advances the narration
 * state — reports each derived pose through onPoseChange so the
 * avatar and the narration can never disagree. The artwork is
 * AI-generated raster imagery; the pose is a symbol of the recorded
 * state, not a measurement, and decoration on the same recorded
 * state, never a signal of its own.
 *
 * Under the condition chips, the "いまの注目" strip shows the one
 * entry condition the narration has declared it is watching (the
 * watched chip carries a ● marker): its current recorded value and
 * how it has moved since the declaration — or, when there is no
 * watch, why not. Like the chips, it derives only from the fresh
 * decision evidence via currentWatch and vanishes when stale.
 *
 * Under the watch strip, a quiet score strip keeps the session's
 * declaration record （宣言/進行中/的中/外れ — total, the live one,
 * then the settled results), and at a milestone the feed itself pauses for a
 * ふりかえり entry (purple border, tagged) built from that same
 * record — both come from agentNarration.ts, never from the
 * component.
 *
 * A sudden market move breaks in as a 速報 entry (orange-red
 * border, tagged): agentNarration.ts detects it from the recorded
 * decision prices and volume change, with a warm-up and a cooldown
 * so it cannot chatter. The component only renders the tag.
 *
 * A recorded buy fill wears a gold frame and a 「買えた！」 tag for
 * good. When one lands as genuinely new this session — an advance
 * after the initialising one adds a fresh buy entry — the feed
 * also reports a celebration through onCelebrate and pulses the
 * new entry once; the loaded history and sell fills never do.
 */
/**
 * One feed entry row. A recorded buy fill is marked for good —
 * gold frame and a 「買えた！」 tag — so a buy stays recognisable
 * in the history, while a sell fill keeps the plain trade look.
 * `justBought` adds the one-shot pulse class for the entry whose
 * arrival just opened a celebration (the pulse itself is defined
 * only when motion is allowed, in style.css).
 */
export function AgentFeedEntryRow({
  entry,
  justBought = false,
  onPromptChip,
  speakerName = "キャラ",
}: {
  entry: NarrationEntry;
  justBought?: boolean;
  /** Tapping the suggested question on a chatPrompt entry asks it. */
  onPromptChip?: (chip: string) => void;
  /** The character's display name, for its speak-up tag. */
  speakerName?: string;
}) {
  const buy = isBuyTradeEntry(entry);
  return (
    <div
      className={`agent-feed-entry ${entry.kind}${buy ? " buy" : ""}${justBought ? " just-bought" : ""}${entry.mono ? " mono" : ""}`}
    >
      <time dateTime={new Date(entry.at).toISOString()}>
        {timeText(entry.at)}
      </time>
      {entry.kind === "review" && (
        <span className="agent-feed-entry-tag">ふりかえり</span>
      )}
      {entry.kind === "alert" && (
        <span className="agent-feed-entry-tag alert">速報</span>
      )}
      {entry.kind === "nearMiss" && (
        <span className="agent-feed-entry-tag nearmiss">ニアミス</span>
      )}
      {entry.kind === "watchHit" && (
        <span className="agent-feed-entry-tag hit">的中</span>
      )}
      {entry.kind === "sleepTalk" && (
        <span className="agent-feed-entry-tag sleep">寝言</span>
      )}
      {entry.kind === "priceLine" && (
        <span className="agent-feed-entry-tag line">買い走りライン</span>
      )}
      {entry.kind === "priceLineReached" && (
        <span className="agent-feed-entry-tag reached">到達</span>
      )}
      {entry.kind === "sellLine" && (
        <span className="agent-feed-entry-tag sell">売りライン</span>
      )}
      {entry.kind === "chatUser" && (
        <span className="agent-feed-entry-tag user">あなた</span>
      )}
      {entry.kind === "chatReply" && (
        <span className="agent-feed-entry-tag reply">
          {entry.mono ? "CMD" : "返信"}
        </span>
      )}
      {entry.kind === "chatPrompt" && (
        <span className="agent-feed-entry-tag reply">{speakerName}</span>
      )}
      {buy && <span className="agent-feed-entry-tag buy">買えた！</span>}
      <p>{entry.text}</p>
      {entry.kind === "chatPrompt" && entry.promptChip && onPromptChip && (
        <button
          type="button"
          className="agent-feed-prompt-chip"
          onClick={() => onPromptChip(entry.promptChip!)}
        >
          {entry.promptChip}
        </button>
      )}
    </div>
  );
}

export function AgentNarrationFeed({
  data,
  stale,
  onPoseChange,
  onCelebrate,
  pairLabel = "SUI",
  active = true,
  agentName = "",
  onListeningChange,
  onSpeakingChange,
}: {
  data: OperationsSnapshot;
  stale: boolean;
  /** The character's user-chosen name ("" shows as キャラ). */
  agentName?: string;
  /** Whether the narration tab is the one on screen. The feed
   * stays mounted (hidden) on other tabs; the fixed chat bar's
   * page-level effects must only apply while it is visible. */
  active?: boolean;
  /** The base symbol of the pair on screen, for chat replies. */
  pairLabel?: string;
  /** Reports the derived pose to the app shell (the header avatar),
   * so the avatar and the feed always agree on the pose. */
  onPoseChange?: (pose: AgentPose) => void;
  /** Fires once when a brand-new recorded buy fill joins the feed
   * this session (never for the loaded history, never for a sell),
   * so the app shell can run the buy celebration. */
  onCelebrate?: () => void;
  /** Reports voice-recognition activity so the shell can switch
   * the header avatar to its listening artwork. */
  onListeningChange?: (listening: boolean) => void;
  /** Reports speech-synthesis activity so the shell can show
   * the avatar mid-speech. */
  onSpeakingChange?: (speaking: boolean) => void;
}) {
  const displayName = agentDisplayName(agentName);
  const [narration, setNarration] = useState<NarrationState>(() =>
    restoreNarration(undefined, pairLabel),
  );
  // Narration storage is scoped per pair (see narrationStorage).
  const persist = (state: NarrationState) =>
    persistNarration(state, undefined, pairLabel);
  const [now, setNow] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const receivedRef = useRef(receivedAt);
  // The state the next advance builds on, mirrored in a ref so the
  // advance effect can diff entries before and after and spot a
  // buy fill that is genuinely new to this session.
  const narrationRef = useRef(narration);
  const hasAdvancedRef = useRef(false);
  // The entry whose arrival opened the running celebration, and
  // when it opened; the pulse class rides on it until the timer
  // clears it, BUY_CELEBRATION_MS after the fill landed.
  const [celebration, setCelebration] = useState<{
    entryId: string;
    startedAt: number;
  } | null>(null);
  const celebrationTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (celebrationTimerRef.current != null)
        window.clearTimeout(celebrationTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const update = () => setNow(Date.now());
    const id = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pageshow", update);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
    };
  }, []);
  useEffect(() => {
    const at = Date.now();
    receivedRef.current = at;
    setReceivedAt(at);
    setNow(at);
  }, [data]);
  useEffect(() => {
    // A stale display must not narrate: the feed freezes with the
    // snapshot until fresh records arrive again.
    if (stale) return;
    const prev = narrationRef.current;
    const next = advanceNarration(
      prev,
      data,
      botVital(data, stale, Date.now(), receivedRef.current).state,
      Date.now(),
    );
    narrationRef.current = next;
    persist(next);
    setNarration(next);
    // A buy celebration opens only here: on an advance after the
    // feed initialised (the initialising advance lays down the
    // recorded history and must never celebrate it), when the
    // advance added a buy fill entry that is fresh news rather
    // than a backlog catching up.
    const firstAdvance = !hasAdvancedRef.current;
    hasAdvancedRef.current = true;
    if (firstAdvance || !prev.initialized) return;
    const hit = findNewBuyEntry(prev.entries, next.entries);
    if (hit && Math.abs(Date.now() - hit.at) <= CELEBRATION_FRESH_MS) {
      setCelebration({ entryId: hit.id, startedAt: Date.now() });
      onCelebrate?.();
      if (celebrationTimerRef.current != null)
        window.clearTimeout(celebrationTimerRef.current);
      celebrationTimerRef.current = window.setTimeout(
        () => setCelebration(null),
        BUY_CELEBRATION_MS,
      );
    }
    // The character speaks up at a fresh milestone (a line
    // declared, a watch hit, a near miss, a sudden move): one
    // prompt per advance at most, appended after the advance's
    // own entries, offering the natural follow-up question.
    const prevIds = new Set(prev.entries.map((e) => e.id));
    const milestone = [...next.entries]
      .reverse()
      .find(
        (e) =>
          !prevIds.has(e.id) &&
          Math.abs(Date.now() - e.at) <= CELEBRATION_FRESH_MS &&
          proactivePrompt(e) != null,
      );
    if (milestone) {
      const prompt = proactivePrompt(milestone)!;
      const cur = narrationRef.current;
      const lastPrompt = [...cur.entries]
        .reverse()
        .find((e) => e.kind === "chatPrompt");
      if (
        !proactivePromptDue(
          lastPrompt?.at ?? null,
          Date.now(),
          isBuyTradeEntry(milestone),
        )
      )
        return;
      const withPrompt: NarrationState = {
        ...cur,
        entries: trimNarrationEntries([
          ...cur.entries,
          {
            id: `narration:${cur.nextEntryId}`,
            at: Date.now(),
            kind: "chatPrompt",
            text: prompt.text,
            promptChip: prompt.chip,
          } satisfies NarrationEntry,
        ]),
        nextEntryId: cur.nextEntryId + 1,
      };
      narrationRef.current = withPrompt;
      persist(withPrompt);
      setNarration(withPrompt);
    }
  }, [data, stale, onCelebrate]);
  const vital = botVital(data, stale, now, receivedAt);
  const pose = agentPose(narration, data, vital, now);
  // While a chat reply is fresh, the character turns to the user
  // with the smile pose (from the base poses only — pointing, the
  // blue line and the rest keep their meaning).
  const [chatReplyAt, setChatReplyAt] = useState<number | null>(null);
  const reportedPose: AgentPose =
    chatReplyAt != null &&
    now - chatReplyAt < 3000 &&
    (pose === "laptop" || pose === "normal")
      ? "pointSmile"
      : pose;
  useEffect(() => {
    onPoseChange?.(reportedPose);
  }, [reportedPose, onPoseChange]);
  const [chatInput, setChatInput] = useState("");
  // The chat box starts folded to a single "キャラに聞く" line so
  // the feed leads; it expands on tap (or when a milestone
  // prompt chip submits through it).
  const [chatOpen, setChatOpen] = useState(false);
  // The chat bar is fixed to the screen bottom (see style.css);
  // while this tab is on screen it raises the corner avatar chip
  // above itself via page-level classes (the line-mode pattern).
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.classList.add("chat-bar");
    root.classList.toggle("chat-bar-open", chatOpen);
    return () => {
      root.classList.remove("chat-bar", "chat-bar-open");
    };
  }, [active, chatOpen]);
  const [chatTopic, setChatTopic] = useState<ChatTopic | null>(null);
  const [chatThinking, setChatThinking] = useState(false);
  const chatTimer = useRef<number | null>(null);
  // Japanese IME: the Enter that confirms a conversion must not
  // submit the comment.
  const composingRef = useRef(false);
  useEffect(
    () => () => {
      if (chatTimer.current != null) window.clearTimeout(chatTimer.current);
    },
    [],
  );
  // The data-derived half of the chat context, refreshed after
  // every render: the reply is composed when it LANDS, from the
  // freshest snapshot, not from the moment the user hit send.
  const chatCtxRef = useRef<Pick<
    AgentChatContext,
    "dec" | "score" | "running" | "stoppedKind" | "pairLabel"
  > | null>(null);
  const [chatReplyText, setChatReplyText] = useState("");
  const submitChat = (raw: string) => {
    const text = raw.trim().slice(0, 120);
    if (!text || chatThinking) return;
    setChatOpen(true);
    const state = narrationRef.current;
    const at = Date.now();
    const withUser: NarrationState = {
      ...state,
      entries: trimNarrationEntries([
        ...state.entries,
        {
          id: `narration:${state.nextEntryId}`,
          at,
          kind: "chatUser",
          text,
        } satisfies NarrationEntry,
      ]),
      nextEntryId: state.nextEntryId + 1,
    };
    narrationRef.current = withUser;
    persist(withUser);
    setNarration(withUser);
    setChatInput("");
    setChatThinking(true);
    // A short thinking beat before the reply lands, so the
    // exchange reads as a conversation rather than a lookup. The
    // reply itself is composed inside the timer, from the
    // freshest records available at that moment.
    chatTimer.current = window.setTimeout(() => {
      chatTimer.current = null;
      const prev = narrationRef.current;
      const history = prev.priceHistory;
      const lastReply = [...prev.entries]
        .reverse()
        .find((e) => e.kind === "chatReply");
      const base = chatCtxRef.current;
      const ctx: AgentChatContext = {
        dec: base?.dec ?? null,
        score: base?.score ?? null,
        running: base?.running ?? false,
        stoppedKind: base?.stoppedKind ?? null,
        pairLabel: base?.pairLabel ?? pairLabel,
        linePrice: prev.priceLine?.price ?? null,
        tradeCount: prev.entries.filter((e) => e.kind === "trade").length,
        recentMovePct:
          history.length >= 2 && history[0] > 0
            ? (history[history.length - 1] / history[0] - 1) * 100
            : null,
        lastTopic: (lastReply?.topic as ChatTopic | undefined) ?? null,
        exchangeCount: prev.entries.filter((e) => e.kind === "chatReply")
          .length,
      };
      const command = isCommandText(text);
      const reply = command
        ? { text: runChatCommand(text, ctx), topic: null, mono: true }
        : { ...agentReply(text, ctx), mono: false };
      const landedAt = Date.now();
      const next: NarrationState = {
        ...prev,
        entries: trimNarrationEntries([
          ...prev.entries,
          {
            id: `narration:${prev.nextEntryId}`,
            at: landedAt,
            kind: "chatReply",
            text: reply.text,
            topic: reply.topic ?? undefined,
            mono: reply.mono || undefined,
          } satisfies NarrationEntry,
        ]),
        nextEntryId: prev.nextEntryId + 1,
      };
      narrationRef.current = next;
      persist(next);
      setNarration(next);
      setChatTopic(reply.topic);
      setChatReplyAt(landedAt);
      setChatReplyText(reply.text);
      // A command readout is for the eyes, not the voice.
      if (!command) speakReply(reply.text);
      setChatThinking(false);
    }, 650);
  };
  // Voice input: one recognition session at a time, feeding the
  // same submitChat path as typing. The mic renders only where
  // the platform offers recognition at all.
  const voiceSupported = voiceRecognitionCtor() !== null;
  const [voiceListening, setVoiceListening] = useState(false);
  const voiceRef = useRef<VoiceSession | null>(null);
  useEffect(() => {
    onListeningChange?.(voiceListening);
  }, [voiceListening, onListeningChange]);
  useEffect(
    () => () => {
      voiceRef.current?.stop();
      voiceRef.current = null;
    },
    [],
  );
  const stopListening = () => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setVoiceListening(false);
  };
  /** Append a character line directly (no thinking beat): used
   * when recognition itself failed and there is no question to
   * answer, only something to say about it. */
  const sayChatLine = (text: string) => {
    const prev = narrationRef.current;
    const next: NarrationState = {
      ...prev,
      entries: trimNarrationEntries([
        ...prev.entries,
        {
          id: `narration:${prev.nextEntryId}`,
          at: Date.now(),
          kind: "chatReply",
          text,
        } satisfies NarrationEntry,
      ]),
      nextEntryId: prev.nextEntryId + 1,
    };
    narrationRef.current = next;
    persist(next);
    setNarration(next);
    setChatReplyText(text);
    speakReply(text);
  };
  const toggleVoice = () => {
    if (voiceListening) {
      stopListening();
      return;
    }
    if (chatThinking) return;
    const session = startListening({
      onInterim: (text) => setChatInput(text.slice(0, 120)),
      onFinal: (text) => {
        setChatInput(text.slice(0, 120));
        stopListening();
        submitChat(text);
      },
      onError: (kind) => {
        stopListening();
        sayChatLine(
          kind === "denied"
            ? "マイクが使えなかった…許可を確認してみて"
            : "聞き取れなかった…もう一回お願いできる？",
        );
      },
      onEnd: () => {
        voiceRef.current = null;
        setVoiceListening(false);
      },
    });
    if (session) {
      voiceRef.current = session;
      setChatOpen(true);
      setVoiceListening(true);
    }
  };
  // The character's voice (spoken replies): opt-in and
  // device-local. Only chat replies are spoken.
  const speechSupported = isSpeechSupported();
  const [voiceOn, setVoiceOn] = useState<boolean>(() => loadAgentVoice());
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const speakerRef = useRef<AgentSpeaker | null>(null);
  const speaker = (): AgentSpeaker => {
    if (!speakerRef.current) {
      speakerRef.current = createAgentSpeaker({
        onSpeakingChange: (speaking) => onSpeakingChange?.(speaking),
      });
    }
    return speakerRef.current;
  };
  useEffect(
    () => () => {
      speakerRef.current?.cancel();
    },
    [],
  );
  const speakReply = (text: string) => {
    if (voiceOnRef.current) speaker().speak(text);
  };
  const toggleVoiceOut = () => {
    const next = !voiceOn;
    setVoiceOn(next);
    saveAgentVoice(next);
    if (next) {
      // This tap is the gesture that unlocks audio; the short
      // confirmation both proves it and performs the unlock.
      speaker().speak("声、オンになったよ");
    } else {
      speaker().cancel();
    }
  };
  // Buy-condition chips come from the same fresh decision evidence
  // as the narration; a stale display shows no chips at all.
  const chips = stale
    ? null
    : currentConditionChips(narration, data.decision, now);
  // The declared watch, from the same evidence and freshness rule.
  const watch = stale
    ? null
    : currentWatch(narration, data.decision, vital.state, now);
  // The declaration score, under the same freshness rule.
  const score = stale ? null : currentWatchScore(narration, data.decision, now);
  useEffect(() => {
    chatCtxRef.current = {
      dec: chips ? data.decision : null,
      score,
      running: vital.state === "alive" || vital.state === "weak",
      stoppedKind:
        vital.state === "sleeping"
          ? "sleeping"
          : vital.state === "flatlined"
            ? "safety"
            : vital.state === "weak"
              ? "weak"
              : null,
      pairLabel,
    };
  });

  return (
    <section className="agent-feed" aria-label="エージェント実況">
      {chips && (
        <div className="agent-feed-chips" aria-label="買い条件">
          <span className="agent-feed-chips-title">買い条件</span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className={`agent-feed-chip tone-${chip.tone}${chip.watching ? " watching" : ""}`}
              title={`${chip.label}：${chip.status}`}
            >
              <span className="agent-feed-chip-dot" aria-hidden="true" />
              <span className="agent-feed-chip-label">{chip.label}</span>
              {chip.detail && (
                <span className="agent-feed-chip-status">{chip.detail}</span>
              )}
              <span className="sr-only">{chip.status}</span>
            </span>
          ))}
        </div>
      )}
      {watch && (
        <div className="agent-feed-watch" aria-label="いまの注目">
          <span className="agent-feed-watch-title">いまの注目</span>
          <strong>{watch.label}</strong>
          {watch.value && (
            <span className="agent-feed-watch-value">{watch.value}</span>
          )}
          <span className="agent-feed-watch-detail">{watch.detail}</span>
        </div>
      )}
      {score && (
        <div className="agent-feed-score" aria-label="宣言の成績">
          <span className="agent-feed-score-item">
            <small>宣言</small>
            {score.declared}回
          </span>
          <span className="agent-feed-score-item prog">
            <small>進行中</small>
            {score.inProgress}
          </span>
          <span className="agent-feed-score-item hit">
            <small>的中</small>
            {score.hits}
          </span>
          <span className="agent-feed-score-item miss">
            <small>外れ</small>
            {score.misses}
          </span>
        </div>
      )}
      <div className="agent-chat">
        <p className="sr-only" role="status">
          {chatReplyText}
        </p>
        {!chatOpen ? (
          <button
            type="button"
            className="agent-chat-open"
            aria-expanded={false}
            onClick={() => setChatOpen(true)}
          >
            {displayName}に聞く
          </button>
        ) : (
          <>
        <div
          className="agent-chat-chips"
          role="group"
          aria-label={`${displayName}への質問候補`}
        >
          {isCommandText(chatInput) ? (
            commandSuggestions(chatInput).map((cmd) => (
              <button
                key={cmd.name}
                type="button"
                disabled={chatThinking}
                onClick={() => submitChat(cmd.name)}
              >
                {cmd.name}（{cmd.hint}）
              </button>
            ))
          ) : (
            <>
              {(chatTopic == null
                ? orderedChips(
                    narration.entries
                      .filter((e) => e.kind === "chatUser")
                      .map((e) => e.text),
                  )
                : followUpChips(chatTopic)
              ).map((chip) => (
                <button
                  key={chip}
                  type="button"
                  disabled={chatThinking}
                  onClick={() => submitChat(chip)}
                >
                  {chip}
                </button>
              ))}
              {chatTopic != null && (
                <button
                  type="button"
                  disabled={chatThinking}
                  onClick={() => setChatTopic(null)}
                >
                  ほかの質問
                </button>
              )}
            </>
          )}
          {speechSupported && (
            <button
              type="button"
              className={`agent-voice-toggle${voiceOn ? " on" : ""}`}
              aria-pressed={voiceOn}
              onClick={toggleVoiceOut}
            >
              {voiceOn ? "🔊 声あり" : "🔇 声なし"}
            </button>
          )}
        </div>
        <form
          className="agent-chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (composingRef.current) return;
            submitChat(chatInput);
          }}
        >
          <input
            type="text"
            value={chatInput}
            maxLength={120}
            disabled={chatThinking}
            onChange={(e) => setChatInput(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder={
              voiceListening
                ? "聞いてる…話してね"
                : `${displayName}へのコメント`
            }
            aria-label={`${displayName}へのコメント`}
          />
          {voiceSupported && (
            <button
              type="button"
              className={`agent-chat-mic${voiceListening ? " listening" : ""}`}
              aria-label={voiceListening ? "聞き取りをやめる" : "音声で聞く"}
              aria-pressed={voiceListening}
              disabled={chatThinking}
              onClick={toggleVoice}
            >
              🎤
            </button>
          )}
          <button type="submit" disabled={chatThinking}>
            送信
          </button>
        </form>
        <button
          type="button"
          className="agent-chat-close"
          aria-expanded={true}
          onClick={() => setChatOpen(false)}
        >
          畳む
        </button>
          </>
        )}
      </div>
      <div className="agent-feed-list">
        {chatThinking && (
          <article className="agent-feed-entry chatReply thinking" role="status">
            <span className="agent-feed-entry-tag reply">返信</span>
            <p>考え中…</p>
          </article>
        )}
        {narration.entries.length === 0 ? (
          <p className="agent-feed-empty">
            実況を準備中です。Botの記録が届くと、ここに実況が流れます。
          </p>
        ) : (
          // Newest first: the list flows with the page (no inner scroll
          // box), so the latest entry belongs at the top.
          [...narration.entries]
            .reverse()
            .map((entry) => (
              <AgentFeedEntryRow
                key={entry.id}
                entry={entry}
                justBought={celebration?.entryId === entry.id}
                onPromptChip={submitChat}
                speakerName={displayName}
              />
            ))
        )}
      </div>
    </section>
  );
}
