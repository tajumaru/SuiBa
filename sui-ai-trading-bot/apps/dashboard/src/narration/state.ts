import type { DecisionTelemetry } from "../../../worker/src/operations.ts";
export type AgentPose =
  | "normal"
  | "point"
  | "pointSmile"
  | "sleep"
  | "laptop"
  | "buyLine";

export type NarrationKind =
  | "cycle" // a strategy analysis cycle (WAIT / signal / position watch)
  | "trade" // a PAPER fill was recorded
  | "rejection" // a signal fired but a gate turned it down
  | "warning" // API failure, anomaly, degraded connectivity
  | "stop" // the bot stopped (manual or safety)
  | "start" // the bot started
  | "recovery" // connectivity recovered / run resumed
  | "review" // a ふりかえり look-back over the watch score so far
  | "nearMiss" // a called watch withdrawn — it came close, then slipped away
  | "watchHit" // a declared watch clicked — the smug counterpart of a near miss
  | "priceLine" // the buy-run line declared — RSI's target price, called out loud
  | "priceLineReached" // the price touched the declared buy-run line
  | "sellLine" // the sell lines declared — take-profit / stop-loss prices of the open position
  | "sleepTalk" // a mutter from the sleeping character, built from recorded facts
  | "alert" // a 速報 breaking in on a sudden price / volume move
  | "chatUser" // a comment the user typed to the character
  | "chatReply" // the character's record-grounded reply (agentChat.ts)
  | "chatPrompt" // the character speaking up at a milestone, with a suggested question
  | "epoch" // a new Sui epoch began (the chain's own daily milestone)
  | "monthlyReport" // the finished month's report card, posted once
  | "btc" // market weather: BTC moved an hour's worth, worth a mutter
  | "forecastCall" // a direction-claiming chart forecast, declared out loud
  | "forecastHit" // a declared forecast whose direction came true
  | "forecastMiss" // a declared forecast whose direction did not
  | "forecastTouch" // a declared forecast's touch line was reached
  | "forecastTouchNear" // the touch line was nearly reached before time ran out
  | "bookWall" // an order-book wall appeared / vanished / was breached
  | "forecastCalib" // the cone's width learned from its scored record
  | "status"; // feed-initialised status line

export interface NarrationEntry {
  id: string;
  at: number;
  kind: NarrationKind;
  text: string;
  /** Fill side, recorded only on trade entries (from the candidate
   * audit's finalAction). Lets the display tell a buy fill from a
   * sell fill without re-reading the wording. */
  side?: "BUY" | "SELL";
  /** Chat topic, recorded only on chatReply entries (agentChat's
   * ChatTopic as a plain string, to keep the modules decoupled):
   * the conversation memory the next reply reads. */
  topic?: string;
  /** A slash-command reply: rendered as a monospace readout
   * with a CMD tag, and never spoken aloud. */
  mono?: boolean;
  /** The suggested question on a chatPrompt entry, rendered as a
   * tappable chip inside the entry. */
  promptChip?: string;
  /** The forecast's origin (candle timestamp, seconds),
   * recorded only on forecast declaration and verdict entries
   * (forecastCall / forecastHit / forecastMiss): the identity
   * of the one forecast the entry speaks of, so a verdict can
   * be paired with the exact declaration that promised it —
   * several forecasts can be outstanding at once, so unlike
   * the serial watches their pairing cannot be recovered
   * reliably from the texts alone. */
  forecastOrigin?: number;
}

/**
 * The declared watch: one unmet entry condition the narration has
 * announced it is keeping an eye on. `declaredDistance` is the
 * empirical distance (see watchDistance) at declaration time and is
 * the baseline for the approach call-out and the withdrawal
 * hysteresis; `called` makes the call-out once per declaration.
 * `closestDistance` is the smallest distance seen while watching —
 * the near-miss line names it when a called watch slips away.
 */
export interface WatchTarget {
  key: "emaUp" | "rsiRecovery" | "histogramImproving";
  declaredDistance: number;
  called: boolean;
  closestDistance: number;
}

/**
 * The session score of declared watches. `declared` counts every
 * watch ever declared this session (a switch target is a new
 * declaration of its own; the silent first watch counts too, as in
 * the approved prototype). `hits` / `misses` count settled watches:
 * a hit is a watched condition that clicked while watched —
 * including clicking as the last condition into a BUY — and a miss
 * is a watch withdrawn by the drift hysteresis. A watch that ends
 * silently is neither. `unreviewed` counts settlements since the
 * last review entry; it drives the review milestone and resets when
 * a review is told, while the other counters are cumulative.
 */
export interface WatchScore {
  declared: number;
  hits: number;
  misses: number;
  unreviewed: number;
}

/** Settlements split by the watched condition (the character's
 * per-kind record — the material for its 得意技）. Counted only at
 * the same moments the session score settles a watch, so the two
 * can never disagree; a watch that ends silently counts in
 * neither, exactly as in WatchScore. */
export interface WatchKindStat {
  hits: number;
  misses: number;
}
export type WatchKindStats = Record<EntryCondKey, WatchKindStat>;

export function emptyWatchKindStats(): WatchKindStats {
  return {
    emaUp: { hits: 0, misses: 0 },
    rsiRecovery: { hits: 0, misses: 0 },
    histogramImproving: { hits: 0, misses: 0 },
  };
}

/** Which way a spike alert jumped; "volume" is a volume-only spike. */
export type SpikeAlertDirection = "up" | "down" | "volume";

export interface NarrationState {
  entries: NarrationEntry[];
  nextEntryId: number;
  priceRising: boolean;
  /** Decision prices of recent narrated cycles (oldest first,
   * capped), the look-back the spike alerts compare against. Seeded
   * by the feed's first recorded decision. */
  priceHistory: number[];
  /** Narrated cycles still silenced after the last spike alert. */
  alertCooldown: number;
  /** The newest spike alert, for pose linkage: the character points
   * on the very cycle an upward alert fired, and never celebrates a
   * downward one. */
  lastAlert: { at: number; direction: SpikeAlertDirection } | null;
  /** When a watch hit was last TOLD (the smug line), for pose
   * linkage: the character flashes its pointing smile while the
   * hit is fresh. Silent settlements (a hit inside a BUY) do not
   * set this — the trade celebration covers those. */
  lastHitAt: number | null;
  /** The most recent TOLD near miss (key + closest distance), the
   * sleep talk's favourite material. */
  lastNearMiss: { key: EntryCondKey; closestDistance: number } | null;
  /** When the current sleep began (first advance seen sleeping),
   * and the sleep talk's cadence state: the last mutter's time and
   * text, so the same mutter never repeats back to back. All three
   * reset when the bot wakes. */
  sleepingSince: number | null;
  lastSleepTalkAt: number | null;
  lastSleepTalkText: string | null;
  /** The declared watch target, or null when nothing is watched. */
  watch: WatchTarget | null;
  /** The declared buy-run line, or null: the RSI target price the
   * feed called out, whether the price has touched it yet, and
   * whether the one approaching murmur has already been told. */
  priceLine: { price: number; reached: boolean; murmured: boolean } | null;
  /** The open position's sell lines, or null: the take-profit and
   * stop-loss prices derived from the recorded entry price and the
   * strategy's percentages, declared once per position. */
  sellLines: { tp: number; sl: number } | null;
  /** Cumulative session score of declared watches (see WatchScore). */
  watchScore: WatchScore;
  /** The same settlements split by watched condition (see
   * WatchKindStats). */
  watchKindStats: WatchKindStats;
  /** Price of the first decision evidence this session received. */
  sessionStartPrice: number | null;
  /** Dedupe keys for operation events (`e:...`) and candidates (`c:...`). */
  seen: string[];
  /** Retirement barriers advance only when keys are evicted. Late records at
   * or before retired times are omitted, while recent same-time arrivals work. */
  retiredEventThrough: number | null;
  retiredCandidateThrough: number | null;
  /** Permit an observed PENDING candidate to finish behind the barrier. */
  pendingCandidateIds: string[];
  /** evaluatedAt of the newest decision already accounted for. */
  lastDecisionAt: number | null;
  /** Price of the previous narrated cycle, for grounded price-move text. */
  prevDecisionPrice: number | null;
  /** Narratable facts of the newest decision accounted for. */
  lastTrail: DecisionTrail | null;
  /** The decision before that, for approach / retreat narration. */
  prevTrail: DecisionTrail | null;
  lastConnectivity: string | null;
  lastStatus: string | null;
  initialized: boolean;
  /** Per-month tallies (JST month keys "YYYY-MM") counted at the
   * same authoritative moments as the watch score and the stop /
   * trade drafts, so a finished month can be reported exactly.
   * Counting started when the monthly report shipped — earlier
   * months simply have no counters. */
  monthly: Record<string, MonthlyCounters>;
  /** The newest month key a monthlyReport entry was posted for,
   * so the finalisation fires exactly once per month. */
  monthlyFinalised: string | null;
  /** The last BTC weather mutter told, for its per-direction
   * cooldown. Ambience bookkeeping only. */
  lastBtcMutter: { at: number; direction: "up" | "down" } | null;
  /** Order-book walls currently tracked by the wall watch
   * (narration/book.ts). Ambience bookkeeping only. */
  bookWalls: import("./book.ts").BookWall[];
  /** The `at` of the last book snapshot the wall watch
   * processed. */
  bookAt: number | null;
  /** Whether the wall watch has silently adopted the walls
   * that were standing when the feed opened. */
  bookAdopted: boolean;
  /** The last book entry told, for the wall watch's spacing. */
  lastBookEntryAt: number | null;
  /** Per-level re-appearance cooldowns of the wall watch. */
  bookWallCooldowns: Record<string, number>;
  /** Chart forecasts the feed has declared out loud, by origin
   * (seconds, as a string key) → when the declaration was told.
   * Only direction-claiming forecasts are ever declared; the
   * record is what entitles a forecast to a verdict entry when
   * its horizon closes. */
  forecastDeclared: Record<string, number>;
  /** Declared forecasts whose verdict has been settled — told
   * (hit or miss) or quietly closed when it came too late to
   * tell. By origin, like forecastDeclared. */
  forecastSettled: Record<string, boolean>;
  /** Declared forecasts whose touch target has been settled —
   * reached, nearly reached, or quietly closed. By origin. */
  forecastTouchSettled: Record<string, boolean>;
  /** When the last forecast declaration was told; declarations
   * are spaced at least an hour apart so a trending market
   * cannot turn the feed into a forecast ticker. */
  lastForecastCallAt: number | null;
  /** Scored-record count of the newest cone calibration the
   * feed has taken in (told or quietly adopted). */
  lastCalibScoredAt: number;
}

/** One JST month of feed-side tallies for the monthly report.
 * The money side (PnL, win rate) is computed from the engine's
 * fills at read time; these counters cover what only the feed
 * witnesses: watches, near misses and stops. */
export interface MonthlyCounters {
  declared: number;
  hits: number;
  misses: number;
  nearMisses: number;
  /** Non-manual STOP events, total and by reason code. */
  stops: number;
  stopReasons: Record<string, number>;
  fillsBuy: number;
  fillsSell: number;
}

export function emptyMonthlyCounters(): MonthlyCounters {
  return {
    declared: 0,
    hits: 0,
    misses: 0,
    nearMisses: 0,
    stops: 0,
    stopReasons: {},
    fillsBuy: 0,
    fillsSell: 0,
  };
}

export const MAX_NARRATION_ENTRIES = 30;
/** Chat entries (the user's comments, the replies, the
 * character's prompts) keep their own allowance on top of the
 * narration cap, so a long conversation cannot push the
 * narration history out — and the narration cannot starve the
 * conversation either. */
export const MAX_CHAT_ENTRIES = 12;

export const CHAT_KINDS: ReadonlySet<NarrationKind> = new Set([
  "chatUser",
  "chatReply",
  "chatPrompt",
]);

/** Trim to the newest MAX_NARRATION_ENTRIES narration entries
 * plus the newest MAX_CHAT_ENTRIES chat entries, order kept. */
export function trimNarrationEntries(
  entries: NarrationEntry[],
): NarrationEntry[] {
  let chatSeen = 0;
  let plainSeen = 0;
  const keep = new Set<number>();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (CHAT_KINDS.has(entries[i].kind)) {
      if (chatSeen++ < MAX_CHAT_ENTRIES) keep.add(i);
    } else if (plainSeen++ < MAX_NARRATION_ENTRIES) {
      keep.add(i);
    }
  }
  return entries.filter((_, i) => keep.has(i));
}
export const MAX_SEEN_KEYS = 200;
export const DECISION_FRESH_MS = 360_000;

export function freshDecision(dec: DecisionTelemetry | null | undefined, now: number) {
  return (
    dec != null &&
    dec.evaluatedAt > 0 &&
    dec.evaluatedAt <= now &&
    now - dec.evaluatedAt <= DECISION_FRESH_MS &&
    dec.candleTimestamp > 0 &&
    dec.candleTimestamp <= dec.evaluatedAt &&
    now - dec.candleTimestamp <= DECISION_FRESH_MS
  );
}

export function emptyNarrationState(): NarrationState {
  return {
    entries: [],
    nextEntryId: 0,
    priceRising: false,
    priceHistory: [],
    alertCooldown: 0,
    lastAlert: null,
    lastHitAt: null,
    lastNearMiss: null,
    priceLine: null,
    sellLines: null,
    sleepingSince: null,
    lastSleepTalkAt: null,
    lastSleepTalkText: null,
    watch: null,
    watchScore: { declared: 0, hits: 0, misses: 0, unreviewed: 0 },
    watchKindStats: emptyWatchKindStats(),
    sessionStartPrice: null,
    seen: [],
    retiredEventThrough: null,
    retiredCandidateThrough: null,
    pendingCandidateIds: [],
    lastDecisionAt: null,
    prevDecisionPrice: null,
    lastTrail: null,
    prevTrail: null,
    lastConnectivity: null,
    lastStatus: null,
    initialized: false,
    monthly: {},
    monthlyFinalised: null,
    lastBtcMutter: null,
    bookWalls: [],
    bookAt: null,
    bookAdopted: false,
    lastBookEntryAt: null,
    bookWallCooldowns: {},
    forecastDeclared: {},
    forecastSettled: {},
    forecastTouchSettled: {},
    lastForecastCallAt: null,
    lastCalibScoredAt: 0,
  };
}

/**
 * A compact copy of one decision's narratable facts, kept in the
 * narration state so the next cycle can be told as a change
 * (approach / newly met / broken) instead of a static readout.
 * Every value is copied verbatim from the telemetry; the condition
 * flags keep the telemetry field names on purpose.
 */
export interface DecisionTrail {
  evaluatedAt: number;
  price: number;
  ema20: number;
  ema50: number;
  rsi: number;
  histogram: number;
  atr: number;
  oversold: number;
  emaUp: boolean;
  emaGapShrinking: boolean;
  rsiRecovery: boolean;
  histogramImproving: boolean;
  hasPosition: boolean;
  /** The buy-run line recorded with this decision, or null. */
  rsiLinePrice: number | null;
}

export type EntryCondKey = "emaUp" | "rsiRecovery" | "histogramImproving";

export type ConditionChipTone = "met" | "close" | "far" | "back";
export interface EntryConditionChip {
  key: "ema" | "rsi" | "macd";
  label: string;
  met: boolean;
  /**
   * The precise state word ("✓", "圏内", "後退", …). No longer shown
   * as visible text — the chip leads with a traffic-light dot in the
   * tone colour — but kept for assistive text and the hover title so
   * the exact state is never more than a tap away.
   */
  status: string;
  /**
   * The one figure still shown as text next to the dot: the RSI
   * distance to the oversold line ("あと7"). Only the RSI chip sets
   * it — a countdown in points is information, not a vague word.
   */
  detail?: string;
  tone: ConditionChipTone;
  /** True while this condition is the declared watch target. */
  watching: boolean;
}

export interface WatchDisplay {
  /** The watched condition, or null when there is no watch. */
  key: EntryCondKey | null;
  /** Target name ("EMAの差" / "RSI" / "MACD"), or "なし". */
  label: string;
  /** Current value phrase ("今 -0.38%"), empty when there is no watch. */
  value: string;
  /** Change since the declaration, or why there is no watch. */
  detail: string;
}

export interface WatchScoreDisplay {
  declared: number;
  hits: number;
  misses: number;
  /** 1 while a watch is live, otherwise 0. */
  inProgress: number;
  /** Settlements split by watched condition (see WatchKindStats). */
  kindStats: WatchKindStats;
  /** The character's specialty: the kind with the best hit rate
   * among those settled at least SPECIALTY_MIN_JUDGED times, or
   * null while no kind has enough of a record to name one. */
  specialty: {
    key: EntryCondKey;
    name: string;
    hits: number;
    judged: number;
  } | null;
}

export interface SpikeAlert {
  direction: SpikeAlertDirection;
  text: string;
}

export type EntryDraft = Omit<NarrationEntry, "id">;
