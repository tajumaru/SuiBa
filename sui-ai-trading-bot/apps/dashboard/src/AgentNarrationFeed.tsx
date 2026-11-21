import type { OperationsSnapshot } from "./operationsTypes.ts";
import type {
  AgentPose,
  NarrationEntry,
  NarrationState,
  PointSmileCause,
} from "./agentNarration.ts";
import { agentDisplayName } from "./agentName.ts";
import { greetingText } from "./narration/voice.ts";
import { useAgentCharacter } from "./agentCharacter.ts";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { persistNarration, restoreNarration } from "./narrationStorage.ts";
import {
  BUY_CELEBRATION_MS,
  CELEBRATION_FRESH_MS,
  advanceNarration,
  agentPoseDetails,
  currentConditionChips,
  currentWatch,
  currentWatchScore,
  findNewBuyEntry,
  isBuyTradeEntry,
  trimNarrationEntries,
} from "./agentNarration.ts";
import { botVital } from "./botVital.ts";
import {
  appendHighlights,
  captureHighlights,
  loadHighlights,
  saveHighlights,
} from "./highlightStore.ts";
import type { Highlight } from "./highlightStore.ts";
import { proactivePrompt, proactivePromptDue } from "./agentChat.ts";
import { epochTransition, loadLastEpoch, saveLastEpoch } from "./epochMark.ts";
/* The replay overlay opens only when the reader taps a saved
 * highlight, so it loads on first open instead of riding in the
 * initial bundle with the live feed itself. */
const HighlightReplay = lazy(() =>
  import("./HighlightReplay.tsx").then((m) => ({
    default: m.HighlightReplay,
  })),
);
import { AgentFeedEntryRow } from "./AgentFeedEntryRow.tsx";
import { usePrefersReducedMotion } from "./usePrefersReducedMotion.ts";
import { useFeedScroll } from "./useFeedScroll.ts";
import { useAgentChat } from "./useAgentChat.ts";
import { AgentChatComposer } from "./AgentChatComposer.tsx";
import {
  useNarrationShadow,
  type NarrationShadowDiagnostics,
} from "./narrationShadow.ts";
import type { SettingsApi } from "./settingsPresets.ts";
import {
  selectDisplayEntries,
  useNarrationServerDisplay,
} from "./narrationServerDisplay.ts";

export function findNewLatestEntryIds(
  previousIds: ReadonlySet<string>,
  entries: readonly NarrationEntry[],
  initialLoadComplete = true,
) {
  if (!initialLoadComplete) return new Set<string>();
  let latestPreviousIndex = -1;
  entries.forEach((entry, index) => {
    if (previousIds.has(entry.id)) latestPreviousIndex = index;
  });
  return new Set(
    entries
      .slice(latestPreviousIndex + 1)
      .filter((entry) => !previousIds.has(entry.id))
      .map((entry) => entry.id),
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
  chain = null,
  trades,
  btc = null,
  forecasts = null,
  calibEvent = null,
  book = null,
  hardMode = false,
  onListeningChange,
  onSpeakingChange,
  api,
  pair,
  onShadowDiagnostics,
}: {
  data: OperationsSnapshot;
  stale: boolean;
  /** The latest BTC weather sample (display-only), for the
   * character's ambient mutters about the market's weather. */
  btc?: import("../../../packages/shared/src/index.ts").BtcInfo | null;
  /** The latest top-of-book levels (display-only), for the
   * character's order-book wall watch. */
  book?: import("../../../packages/shared/src/index.ts").BookLevels | null;
  /** The chart's recorded forecasts and the 5-minute candles
   * that judge them (display-only), so the character can declare
   * a direction-claiming forecast and tell its verdict when the
   * horizon closes. */
  forecasts?: {
    records: readonly import("./forecastLog.ts").ForecastRecord[];
    candles: readonly import("../../../packages/shared/src/index.ts").Candle[];
  } | null;
  /** The newest cone-calibration change (display-only), told
   * once by the feed when it is fresh. */
  calibEvent?:
    | import("./forecastCalib.ts").CalibEvent
    | import("./forecastCalib.ts").CalibEvent[]
    | null;
  /** The engine's newest fills, threaded to the narration
   * advance so a finished month's report can be priced and
   * posted. Display/record only. */
  trades?: readonly import("../../../packages/paper-trading/src/index.ts").Fill[];
  /** The latest Sui chain sample (display-only, from the engine
   * state rather than the operations snapshot), quoted by /status. */
  chain?: { epoch: number; checkpoint: number; tps: number | null } | null;
  /** The character's user-chosen name ("" shows as キャラ). */
  agentName?: string;
  /** The saved settings are the hard preset (presetName, the
   * same judgement as the header's hard-mode mark): the reach
   * calls and the hit line run their hotter variants. */
  hardMode?: boolean;
  /** Whether the narration tab is the one on screen. The feed
   * stays mounted (hidden) on other tabs; the fixed chat bar's
   * page-level effects must only apply while it is visible. */
  active?: boolean;
  /** The base symbol of the pair on screen, for chat replies. */
  pairLabel?: string;
  /** Reports the derived pose to the app shell (the header avatar),
   * so the avatar and the feed always agree on the pose. */
  onPoseChange?: (pose: AgentPose, pointSmileCause: PointSmileCause) => void;
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
  /** Stage-2 read shadow: comparison only; it never supplies rendered entries. */
  api?: SettingsApi;
  pair?: "SUI_USDC" | "WAL_USDC";
  onShadowDiagnostics?: (diagnostics: NarrationShadowDiagnostics) => void;
}) {
  const character = useAgentCharacter();
  const displayName = agentDisplayName(agentName, character);
  const [narration, setNarration] = useState<NarrationState>(() =>
    restoreNarration(undefined, pairLabel),
  );
  // Narration storage is scoped per pair (see narrationStorage).
  const persist = (state: NarrationState) =>
    persistNarration(state, undefined, pairLabel);
  const openMemorySeal = (entryId: string) => {
    const state = narrationRef.current;
    const opened = state.openedMemorySealIds ?? [];
    if (opened.includes(entryId)) return;
    const next = {
      ...state,
      openedMemorySealIds: [...opened, entryId].slice(-200),
    };
    narrationRef.current = next;
    persist(next);
    setNarration(next);
  };
  const [now, setNow] = useState(() => Date.now());
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const receivedRef = useRef(receivedAt);
  // The state the next advance builds on, mirrored in a ref so the
  // advance effect can diff entries before and after and spot a
  // buy fill that is genuinely new to this session.
  const narrationRef = useRef(narration);
  useNarrationShadow(api, pair, narration.entries, onShadowDiagnostics);
  const serverDisplay = useNarrationServerDisplay(api, pair);
  const displayEntries = selectDisplayEntries(
    narration.entries,
    serverDisplay.serverEntries,
    serverDisplay.enabled,
  );
  const displayNarrationRef = useRef(narration);
  displayNarrationRef.current = { ...narration, entries: displayEntries };
  // A character switch is greeted by the incoming character:
  // one handover line in the feed, in their own voice. The
  // first mount only records who is speaking — no greeting for
  // the character who was already on duty when the feed opened.
  const prevCharacterRef = useRef(character);
  useEffect(() => {
    const prevCharacter = prevCharacterRef.current;
    prevCharacterRef.current = character;
    if (prevCharacter === character) return;
    const state = narrationRef.current;
    if (!state.initialized) return;
    const text = greetingText(prevCharacter, character, agentName);
    const last = state.entries[state.entries.length - 1];
    if (last?.kind === "greeting" && last.text === text) return;
    const next: NarrationState = {
      ...state,
      entries: trimNarrationEntries([
        ...state.entries,
        {
          id: `narration:${state.nextEntryId}`,
          at: Date.now(),
          kind: "greeting",
          text,
        } satisfies NarrationEntry,
      ]),
      nextEntryId: state.nextEntryId + 1,
    };
    narrationRef.current = next;
    persist(next);
    setNarration(next);
    // persist is re-created per render; the switch itself is
    // the only trigger this effect should answer to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character]);
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
    // 5s, not 1s: the freshness windows behind this clock are
    // 30s+; a 1s tick re-rendered the feed every second and kept
    // phones hot (owner's iPhone heat concern, 2026-11-20).
    const id = setInterval(update, 5000);
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
      trades,
      btc,
      forecasts,
      book,
      pairLabel,
      calibEvent,
      character,
      hardMode,
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
    // Bookmark the advance's fresh highlights (a fill, a hit,
    // a near miss, a line reached, sell lines declared) with
    // their surrounding entries, so the moment can be replayed
    // instead of missed. Loaded history is excluded by the
    // freshness window inside captureHighlights.
    {
      const prevIds = new Set(prev.entries.map((e) => e.id));
      const fresh = captureHighlights(prevIds, next, Date.now());
      if (fresh.length)
        setHighlights((list) => {
          const merged = appendHighlights(list, fresh);
          if (merged !== list) saveHighlights(merged, pairLabel);
          return merged;
        });
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
  }, [
    data,
    stale,
    onCelebrate,
    trades,
    btc,
    forecasts,
    book,
    pairLabel,
    calibEvent,
    character,
    hardMode,
  ]);
  const vital = botVital(data, stale, now, receivedAt);
  const { pose, pointSmileCause } = agentPoseDetails(
    narration,
    data,
    vital,
    now,
  );
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
    onPoseChange?.(
      reportedPose,
      reportedPose === pose ? pointSmileCause : null,
    );
  }, [reportedPose, pose, pointSmileCause, onPoseChange]);
  // Message-order scroll management (stick-to-bottom
  // tracking, the landing scroll, the jump pill's visibility)
  // lives in useFeedScroll; the pill itself renders below.
  const reducedMotion = usePrefersReducedMotion();
  const { jumpVisible, scrollToLatest, forceStick } = useFeedScroll({
    active,
    entries: displayEntries,
    narrationRef: displayNarrationRef,
  });
  const chat = useAgentChat({
    narrationRef,
    persist,
    setNarration,
    pairLabel,
    forceStick,
    setChatReplyAt,
    onListeningChange,
    onSpeakingChange,
  });
  // The feed itself uses only these four; the rest of the chat
  // cluster is consumed by the composer (and the entry rows'
  // prompt chips use submit).
  const { chatOpen, chatThinking, submitChat, chatCtxRef } = chat;
  // Bookmarked highlights (device-local, per pair) and the one
  // currently being replayed, if any.
  const [highlights, setHighlights] = useState<Highlight[]>(() =>
    loadHighlights(pairLabel),
  );
  const [replay, setReplay] = useState<Highlight | null>(null);
  // The restored first render establishes the baseline. On later renders,
  // only IDs added beyond the previous newest entry are live arrivals;
  // older history inserted before that edge must stay still. Once marked,
  // an ID keeps its class so unrelated renders cannot restart the animation.
  const previousEntryIdsRef = useRef<Set<string> | null>(null);
  const initialLoadCompleteRef = useRef(narration.initialized);
  const animatedEntryIdsRef = useRef(new Set<string>());
  const currentEntryIds = new Set(displayEntries.map((entry) => entry.id));
  if (previousEntryIdsRef.current != null) {
    for (const id of findNewLatestEntryIds(
      previousEntryIdsRef.current,
      displayEntries,
      initialLoadCompleteRef.current && serverDisplay.initialLoadComplete,
    ))
      animatedEntryIdsRef.current.add(id);
  }
  previousEntryIdsRef.current = currentEntryIds;
  initialLoadCompleteRef.current =
    narration.initialized && serverDisplay.initialLoadComplete;
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
  // Fresh decision evidence, from the same freshness rule as the
  // narration. The feed header no longer displays the condition chips
  // or the declaration score (owner call, 2026-11-21: the strategy tab
  // carries the conditions and the score was furniture); both still
  // feed the character's chat context below.
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
      chain,
      memwal: data.memwal,
      liquidation: data.liquidation,
    };
  });
  // Epoch boundary: when the chain sample reports a newer epoch
  // than this device last saw, the feed marks the chain's own
  // milestone with one line. The first sighting only records.
  useEffect(() => {
    if (!chain) return;
    const seen = loadLastEpoch();
    const began = epochTransition(seen, chain.epoch);
    if (seen !== chain.epoch) saveLastEpoch(chain.epoch);
    if (began == null) return;
    const prev = narrationRef.current;
    const next: NarrationState = {
      ...prev,
      entries: trimNarrationEntries([
        ...prev.entries,
        {
          id: `narration:${prev.nextEntryId}`,
          at: Date.now(),
          kind: "epoch",
          text: `エポック ${began} が始まった（Suiチェーンの節目）`,
        } satisfies NarrationEntry,
      ]),
      nextEntryId: prev.nextEntryId + 1,
    };
    narrationRef.current = next;
    persist(next);
    setNarration(next);
  }, [chain]);

  return (
    <section className="agent-feed" aria-label="エージェント実況">
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
      {replay && (
        <Suspense fallback={null}>
          <HighlightReplay highlight={replay} onClose={() => setReplay(null)} />
        </Suspense>
      )}
      <AgentChatComposer chat={chat} displayName={displayName} />
      <div className="agent-feed-list">
        {displayEntries.length === 0 ? (
          <p className="agent-feed-empty">
            実況を準備中です。Botの記録が届くと、ここに実況が流れます。
          </p>
        ) : (
          // Message order: oldest first, newest at the bottom,
          // like a chat app — exchanges read top to bottom. The
          // list flows with the page (no inner scroll box); the
          // scroll management above keeps a reader who is at the
          // bottom at the latest entry.
          displayEntries.map((entry) => {
            const highlight = highlights.find((item) => item.id === entry.id);
            return (
              <AgentFeedEntryRow
                key={entry.id}
                entry={entry}
                memorySealed={
                  entry.kind === "memory" &&
                  entry.at >=
                    (narration.memorySealEnabledAt ??
                      Number.POSITIVE_INFINITY) &&
                  !(narration.openedMemorySealIds ?? []).includes(entry.id)
                }
                onOpenMemorySeal={openMemorySeal}
                justBought={celebration?.entryId === entry.id}
                animateIn={animatedEntryIdsRef.current.has(entry.id)}
                onPromptChip={submitChat}
                speakerName={displayName}
                onReplay={highlight ? () => setReplay(highlight) : undefined}
              />
            );
          })
        )}
        {chatThinking && (
          <article
            className="agent-feed-entry chatReply thinking"
            role="status"
          >
            <span className="agent-feed-entry-tag reply">返信</span>
            <p>考え中…</p>
          </article>
        )}
      </div>
      {jumpVisible && (
        <button
          type="button"
          className="agent-feed-jump"
          aria-label="最新の実況へ"
          onClick={() => scrollToLatest(reducedMotion ? "auto" : "smooth")}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      )}
    </section>
  );
}
