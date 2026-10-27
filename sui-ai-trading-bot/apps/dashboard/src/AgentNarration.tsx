import React, { useEffect, useRef, useState } from "react";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import { botVital } from "./botVital.ts";
import type { ErrorShout } from "./errorShout.ts";
import {
  advanceNarration,
  agentPose,
  BUY_CELEBRATION_MS,
  CELEBRATION_FRESH_MS,
  currentConditionChips,
  currentWatch,
  currentWatchScore,
  emptyNarrationState,
  findNewBuyEntry,
  isBuyTradeEntry,
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
};
const POSE_LABEL: Record<AgentPose, string> = {
  normal: "様子を見ています",
  point: "条件が近づいています",
  pointSmile: "売買を記録しました",
  sleep: "止まっています",
  laptop: "様子を見ています",
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
 */
export function AgentAvatarArtwork({ pose }: { pose: AgentPose }) {
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
const AVATAR_DOT_TONE: Record<AgentPose, "run" | "near" | "stop"> = {
  normal: "stop",
  point: "near",
  pointSmile: "near",
  sleep: "stop",
  laptop: "run",
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
}: {
  pose: AgentPose;
  celebrating?: boolean;
  shout?: ErrorShout | null;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const shouting = shout !== null;
  const shownPose: AgentPose = shouting
    ? "normal"
    : celebrating
      ? "pointSmile"
      : pose;
  const animated = celebrating && !reducedMotion && !shouting;
  return (
    <div className="agent-avatar-dock">
      <div
        key={shout ? shout.kind : "calm"}
        className={`agent-avatar pose-${shownPose}${animated ? " celebrating" : ""}${shouting ? " shouting" : ""}`}
        data-pose={shownPose}
        aria-hidden="true"
      >
        <div className="agent-avatar-bob">
          {shouting ? (
            <img className="agent-avatar-scream" src={imgScream} alt="" />
          ) : (
            <AgentAvatarArtwork pose={shownPose} />
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
      </div>
      <p
        className={`agent-avatar-pill${celebrating && !shouting ? " celebrate" : ""}${shouting ? " shout" : ""}`}
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
            : POSE_LABEL[shownPose]}
      </p>
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
 * declaration record （宣言/的中/外れ/進行中） with its counting
 * definitions, and at a milestone the feed itself pauses for a
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
}: {
  entry: NarrationEntry;
  justBought?: boolean;
}) {
  const buy = isBuyTradeEntry(entry);
  return (
    <div
      className={`agent-feed-entry ${entry.kind}${buy ? " buy" : ""}${justBought ? " just-bought" : ""}`}
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
      {buy && <span className="agent-feed-entry-tag buy">買えた！</span>}
      <p>{entry.text}</p>
    </div>
  );
}

export function AgentNarrationFeed({
  data,
  stale,
  onPoseChange,
  onCelebrate,
}: {
  data: OperationsSnapshot;
  stale: boolean;
  /** Reports the derived pose to the app shell (the header avatar),
   * so the avatar and the feed always agree on the pose. */
  onPoseChange?: (pose: AgentPose) => void;
  /** Fires once when a brand-new recorded buy fill joins the feed
   * this session (never for the loaded history, never for a sell),
   * so the app shell can run the buy celebration. */
  onCelebrate?: () => void;
}) {
  const [narration, setNarration] = useState<NarrationState>(() =>
    emptyNarrationState(),
  );
  const [now, setNow] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const receivedRef = useRef(receivedAt);
  // The state the next advance builds on, mirrored in a ref so the
  // advance effect can diff entries before and after and spot a
  // buy fill that is genuinely new to this session.
  const narrationRef = useRef(narration);
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
    setNarration(next);
    // A buy celebration opens only here: on an advance after the
    // feed initialised (the initialising advance lays down the
    // recorded history and must never celebrate it), when the
    // advance added a buy fill entry that is fresh news rather
    // than a backlog catching up.
    if (!prev.initialized) return;
    const hit = findNewBuyEntry(prev.entries, next.entries);
    if (!hit || Math.abs(Date.now() - hit.at) > CELEBRATION_FRESH_MS) return;
    setCelebration({ entryId: hit.id, startedAt: Date.now() });
    onCelebrate?.();
    if (celebrationTimerRef.current != null)
      window.clearTimeout(celebrationTimerRef.current);
    celebrationTimerRef.current = window.setTimeout(
      () => setCelebration(null),
      BUY_CELEBRATION_MS,
    );
  }, [data, stale, onCelebrate]);
  const vital = botVital(data, stale, now, receivedAt);
  const pose = agentPose(narration, data, vital, now);
  useEffect(() => {
    onPoseChange?.(pose);
  }, [pose, onPoseChange]);
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
          <span className="agent-feed-score-item hit">
            <small>的中</small>
            {score.hits}
          </span>
          <span className="agent-feed-score-item miss">
            <small>外れ</small>
            {score.misses}
          </span>
          <span className="agent-feed-score-item prog">
            <small>進行中</small>
            {score.inProgress}
          </span>
          <span className="agent-feed-score-note">
            的中＝注目中に成立／外れ＝遠のいて取り下げ。切替先は別の宣言
          </span>
        </div>
      )}
      <div className="agent-feed-list">
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
              />
            ))
        )}
      </div>
      <small className="agent-feed-note">
        実況はBotの実際の記録（取得結果・指標・判定）から自動生成しています。数値はすべて記録に基づきます。表示はPAPER（仮想売買）の記録で、実売買は行いません。キャラクターのポーズは状態の模式表示です。
      </small>
    </section>
  );
}
