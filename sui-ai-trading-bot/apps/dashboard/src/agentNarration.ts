import type { OperationsSnapshot } from "./operationsTypes.ts";
import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import type { BotVital, VitalState } from "./botVital.ts";
import { operationReason } from "./operationLabels.ts";
import { number as fmtNumber, percent as fmtPercent } from "./presentation.ts";

/**
 * The agent narration feed: chat-style entries generated ONLY from
 * records the worker actually stored — operation events, candidate
 * audits, and the validated decision-evidence telemetry in the
 * snapshot. Every number in a text comes from those records; nothing
 * is invented, estimated, or back-filled. When the evidence is missing
 * or malformed the feed stays silent for that cycle (fail-closed),
 * exactly like the vital signs next to it.
 *
 * Cycle narration follows the approved "reasons, softly and shortly"
 * style: one or two short sentences in a companionable tone (never
 * report-style), carrying at least one recorded number, naming the
 * entry condition that is still missing, and — via the previous
 * cycle's DecisionTrail — whether things approached, newly clicked,
 * or fell back since last time.
 *
 * On top of the per-cycle lines, the feed keeps a declared "watch":
 * the one unmet entry condition that looks closest to clicking (by
 * the same normalised distances the narration already uses to pick
 * what to talk about). The watch is announced once when the target
 * changes, gets a single call-out when it closes to half its declared
 * distance, is celebrated — tied back to the declaration — when it
 * clicks, and is honestly withdrawn, with hysteresis so small wobbles
 * cannot flap it, when it drifts clearly further away than declared.
 * A withdrawal after the call-out — it really did come close — is
 * told as a ニアミス (near miss) instead: the closest distance seen
 * while watching is named, and only that line slips into Kansai
 * dialect, the character's disappointment leaking through. A watch
 * that never came close is withdrawn in the plain words, as before.
 * The hit line is its counterpart: the facts stay as recorded, the
 * close turns smug in the same dialect, and the pose flashes the
 * pointing smile while the hit is fresh.
 *
 * Every declaration is also scored: a watch that clicks while it is
 * being watched is a 的中 (hit), one withdrawn for drifting away is
 * an 外れ (miss), and a watch that ends silently (a position opened,
 * the material went away) is neither. Once enough settlements have
 * piled up since the last look-back — or a BUY closes a chapter with
 * at least a couple waiting — the feed pauses for a short ふりかえり
 * (review) built only from those recorded counts and the session's
 * first-to-current price move.
 *
 * While the bot sleeps (a plain stop, never a safety stop), the
 * character occasionally talks in its sleep: at most one mutter
 * per quarter hour, built only from the session's recorded facts
 * (a near miss, a told hit, a recorded buy), never the same one
 * twice in a row, with a fact-free dream of SUI itself as the
 * fallback when the session left nothing to dream about.
 *
 * The feed also keeps a short history of the narrated cycles'
 * decision prices, so a sudden market move — the price jumping at
 * least ±1% against three cycles ago, or the recorded volume change
 * spiking past +200% — can break in as a 速報 (alert). An alert is
 * market news, not a trading judgement: it never replaces the
 * cycle's own line, it stays silent until the price history has
 * warmed up, and after one fires the next is held back for five
 * narrated cycles so a continuing move is not re-announced.
 *
 * All functions here are pure: the component keeps a NarrationState,
 * feeds each new snapshot through `advanceNarration`, and renders the
 * accumulated entries. `agentPose` derives the character's pose from
 * the same state, so pose and text can never disagree.
 */
export type AgentPose = "normal" | "point" | "pointSmile" | "sleep" | "laptop";

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
  | "sleepTalk" // a mutter from the sleeping character, built from recorded facts
  | "alert" // a 速報 breaking in on a sudden price / volume move
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
  /** Cumulative session score of declared watches (see WatchScore). */
  watchScore: WatchScore;
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
}

export const MAX_NARRATION_ENTRIES = 30;
const MAX_SEEN_KEYS = 200;
export const DECISION_FRESH_MS = 360_000;

function freshDecision(dec: DecisionTelemetry | null | undefined, now: number) {
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
    sleepingSince: null,
    lastSleepTalkAt: null,
    lastSleepTalkText: null,
    watch: null,
    watchScore: { declared: 0, hits: 0, misses: 0, unreviewed: 0 },
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

export function decisionTrail(dec: DecisionTelemetry): DecisionTrail {
  return {
    evaluatedAt: dec.evaluatedAt,
    price: dec.price,
    ema20: dec.ema20,
    ema50: dec.ema50,
    rsi: dec.rsi,
    histogram: dec.histogram,
    atr: dec.atr,
    oversold: dec.oversold,
    emaUp: dec.conditions.emaUp,
    emaGapShrinking: dec.conditions.emaGapShrinking,
    rsiRecovery: dec.conditions.rsiRecovery,
    histogramImproving: dec.conditions.histogramImproving,
    hasPosition: dec.conditions.hasPosition,
    rsiLinePrice: dec.rsiLinePrice ?? null,
  };
}

const price = (v: number) => `${fmtNumber(v, 4)} USDC`;
const signedPct = (ratio: number) =>
  `${ratio > 0 ? "+" : ""}${fmtPercent(ratio)}`;

/**
 * A recorded volume change is a ratio against the previous candle,
 * and that candle can be nearly empty: a change off a base of 0.01
 * prints as +499,900%, which reads as a bug even though the
 * division is honest. From this ratio up — the newest candle
 * carried about ten times the previous one's volume — the
 * narration speaks in multiples （約50倍） instead of a
 * percentage. Non-finite changes never reach either shape: the
 * callers fall back to printing no number at all.
 */
const VOLUME_MULTIPLE_THRESHOLD = 9;
const volumeMultiple = (ratio: number): number | null =>
  Number.isFinite(ratio) && ratio >= VOLUME_MULTIPLE_THRESHOLD
    ? Math.round(ratio + 1)
    : null;

/** The three strategy entry conditions, in display order. */
function entryConditions(dec: DecisionTelemetry) {
  return [
    { key: "emaUp", label: "EMAの上昇", met: dec.conditions.emaUp },
    { key: "rsiRecovery", label: "RSIの回復", met: dec.conditions.rsiRecovery },
    {
      key: "histogramImproving",
      label: "MACDの改善",
      met: dec.conditions.histogramImproving,
    },
  ] as const;
}
export function metEntryConditions(dec: DecisionTelemetry): number {
  return entryConditions(dec).filter((c) => c.met).length;
}

/**
 * Normalised "distance" of an unmet entry condition (larger = further
 * away), using display windows only: EMA gap relative to a 1%-of-price
 * window, RSI points relative to a 10-point window, MACD histogram
 * change relative to a quarter-ATR window. These pick WHICH unmet
 * condition the narration talks about; they are not shown as numbers
 * and are not a probability of anything.
 */
function unmetDistance(
  dec: DecisionTelemetry,
  key: "emaUp" | "rsiRecovery" | "histogramImproving",
): number {
  if (key === "emaUp")
    return dec.price > 0 ? (dec.ema50 - dec.ema20) / dec.price / 0.01 : 0;
  if (key === "rsiRecovery")
    // Below the oversold line the recovery cross is the only missing
    // step, so it counts as close; above it, distance grows with the
    // points still to fall before the zone is even reached.
    return dec.rsi <= dec.oversold ? 0.2 : (dec.rsi - dec.oversold) / 10;
  const delta = dec.previousHistogram - dec.histogram;
  return dec.atr > 0 ? delta / (dec.atr * 0.25) : 1;
}

type EntryCondKey = "emaUp" | "rsiRecovery" | "histogramImproving";
const COND_SHORT: Record<EntryCondKey, string> = {
  emaUp: "EMA",
  rsiRecovery: "RSI",
  histogramImproving: "MACD",
};

const emaGapPct = (v: { price: number; ema20: number; ema50: number }) =>
  fmtPercent(v.price > 0 ? (v.ema20 - v.ema50) / v.price : 0);
const rsiPoints = (rsi: number, oversold: number) =>
  Math.max(0, Math.round(rsi - oversold));

/**
 * Per-key distance used ONLY to compare the same condition across two
 * cycles (did it approach since last time?). Scales differ per key
 * and are never shown as numbers.
 */
function trailDistance(key: EntryCondKey, t: DecisionTrail): number {
  if (key === "emaUp") return t.price > 0 ? (t.ema50 - t.ema20) / t.price : 0;
  if (key === "rsiRecovery") return t.rsi - t.oversold;
  return -t.histogram;
}

/** Number-carrying phrase for one unmet entry condition. */
function unmetNumberPhrase(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp") return `EMAの差は${emaGapPct(dec)}`;
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? `RSIは${fmtNumber(dec.rsi, 1)}で圏内、上抜け待ち`
      : `RSI ${fmtNumber(dec.rsi, 1)}、ラインまでまだ${rsiPoints(dec.rsi, dec.oversold)}`;
  return `MACDは${fmtNumber(dec.histogram, 4)}`;
}

/** Number-free aside naming a second unmet entry condition. */
function unmetAside(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp") return "EMAもまだ逆並びだし";
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? "RSIは圏内で待ってるし"
      : "RSIもまだ高めだし";
  return dec.histogram < 0 ? "MACDもマイナス側だし" : "MACDも下向きだし";
}

/** The one remaining condition, named with its recorded number. */
function singleRemainingText(
  key: EntryCondKey,
  dec: DecisionTelemetry,
): string {
  if (key === "emaUp") {
    const gap =
      dec.price > 0 ? Math.abs((dec.ema20 - dec.ema50) / dec.price) : 1;
    return gap <= 0.003
      ? `あとEMAだけ。差は${emaGapPct(dec)}、ほぼ並んだよ`
      : `あとEMAだけ。差は${emaGapPct(dec)}、まだ開いてるね`;
  }
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? "あとRSIだけ。圏内から上抜け待ちだね"
      : `あとRSIだけ。${fmtNumber(dec.rsi, 1)}、ラインまで${rsiPoints(dec.rsi, dec.oversold)}だね`;
  if (
    dec.histogram < 0 &&
    dec.atr > 0 &&
    Math.abs(dec.histogram) <= dec.atr * 0.05
  )
    return `あとMACDだけ。${fmtNumber(dec.histogram, 4)}、ほぼゼロ。次で揃うかも`;
  if (dec.histogram < 0)
    return `あとMACDだけ。まだ${fmtNumber(dec.histogram, 4)}、マイナス側だね`;
  return `あとMACDだけ。${fmtNumber(dec.histogram, 4)}でプラス圏だけど、下向きだね`;
}

/**
 * WAIT-cycle narration: short and soft, but always grounded — one
 * recorded number, the missing condition named, and the change since
 * the previous cycle (a condition that broke is the headline, then a
 * single remaining condition, then a newly met one, then progress).
 */
function waitNarration(
  dec: DecisionTelemetry,
  prev: DecisionTrail | null,
): string {
  const conds = entryConditions(dec);
  const met = conds.filter((c) => c.met).length;
  const unmet = conds.filter((c) => !c.met);
  const wasMet = (key: EntryCondKey) => (prev ? prev[key] : false);

  const broken = unmet.filter((c) => wasMet(c.key));
  if (broken.length) {
    const key = broken[0].key;
    if (key === "emaUp")
      return prev?.emaGapShrinking
        ? `EMAの差の縮小が止まった。差は${emaGapPct(dec)}、一歩さがったなあ`
        : `EMAの並びが崩れた。差は${emaGapPct(dec)}、一歩さがったなあ`;
    if (key === "rsiRecovery")
      return `RSIの回復が消えた。今は${fmtNumber(dec.rsi, 1)}、一歩さがったなあ`;
    return `MACDが崩れて${fmtNumber(dec.histogram, 4)}。一歩さがったなあ`;
  }

  if (!unmet.length) return "買い条件は3つ揃ったよ。今は様子見だね";
  if (unmet.length === 1) return singleRemainingText(unmet[0].key, dec);

  const closestUnmet = () =>
    unmet.reduce((a, b) =>
      unmetDistance(dec, b.key) < unmetDistance(dec, a.key) ? b : a,
    );

  if (met === 1) {
    const newly = conds.filter((c) => c.met && !wasMet(c.key));
    if (prev && newly.length) {
      const n = newly[0].key;
      const lead =
        n === "emaUp"
          ? dec.conditions.emaGapShrinking
            ? "EMAの差が縮み続けて成立扱いになった"
            : "EMAが順並びになった"
          : n === "rsiRecovery"
            ? `RSIが${fmtNumber(dec.previousRsi, 1)}→${fmtNumber(dec.rsi, 1)}で上抜けた`
            : `MACDが${fmtNumber(dec.previousHistogram, 4)}→${fmtNumber(dec.histogram, 4)}に上向いた`;
      const rest = unmet.map((c) => COND_SHORT[c.key]).join("と");
      return `${lead}。残りは${rest}、${unmetNumberPhrase(closestUnmet().key, dec)}だね`;
    }
    const closest = closestUnmet();
    const other = unmet.find((c) => c.key !== closest.key)!;
    return `${unmetNumberPhrase(closest.key, dec)}。${unmetAside(other.key, dec)}、条件は1/3だね`;
  }

  // Nothing met yet: feature the furthest condition (the bottleneck),
  // and say whether even that one approached since the last cycle.
  const furthest = unmet.reduce((a, b) =>
    unmetDistance(dec, b.key) > unmetDistance(dec, a.key) ? b : a,
  );
  const other = unmet.find((c) => c.key !== furthest.key)!;
  const approached =
    prev != null &&
    trailDistance(furthest.key, decisionTrail(dec)) <
      trailDistance(furthest.key, prev);
  return `${unmetNumberPhrase(furthest.key, dec)}。${unmetAside(other.key, dec)}、${approached ? "少し近づいてきたね" : "まだ遠いなあ"}`;
}

/** Narration text for one analysed cycle, from its decision evidence. */
export function cycleNarrationText(
  dec: DecisionTelemetry,
  prev: DecisionTrail | null,
): string {
  if (dec.action === "BUY") {
    if (metEntryConditions(dec) === 3) {
      const parts = [
        dec.conditions.emaGapShrinking
          ? "EMAは差が縮み続けて成立扱い"
          : "EMAは順並び",
        `RSIは${fmtNumber(dec.previousRsi, 1)}→${fmtNumber(dec.rsi, 1)}まで回復`,
        dec.histogram > 0 ? "MACDもプラス" : "MACDも上向き",
      ];
      return `3つ揃ったよ。${parts.join("、")}だから買うね`;
    }
    return `買いシグナルが出たよ。価格は${price(dec.price)}だね`;
  }
  if (dec.action === "SELL") {
    const gain =
      dec.entryPrice != null && dec.entryPrice > 0
        ? signedPct(dec.price / dec.entryPrice - 1)
        : null;
    switch (dec.sellPurpose) {
      case "TAKE_PROFIT":
        return gain
          ? `利確のラインに触れたよ。取得から${gain}だね`
          : `利確のラインに触れたよ。価格は${price(dec.price)}だね`;
      case "STOP_LOSS":
        return gain
          ? `損切りのラインに触れたよ。取得から${gain}だね`
          : `損切りのラインに触れたよ。価格は${price(dec.price)}だね`;
      case "STRATEGY_EXIT":
        return `売りシグナルが出たよ。価格は${price(dec.price)}だね`;
      case "RISK_REDUCTION":
      case "EMERGENCY_EXIT":
        return `リスクを減らす売り判定だよ。価格は${price(dec.price)}だね`;
      default:
        return `売り判定だよ。価格は${price(dec.price)}だね`;
    }
  }
  if (dec.selectedRule === "VOLUME_REJECT") {
    const multiple = volumeMultiple(dec.volumeChange);
    if (multiple != null)
      return `出来高が急に変わったから見送ったよ。変化は約${multiple}倍だね`;
    if (!Number.isFinite(dec.volumeChange))
      return `出来高が急に変わったから見送ったよ`;
    return `出来高が急に変わったから見送ったよ。変化は${fmtPercent(dec.volumeChange)}だね`;
  }
  if (dec.conditions.hasPosition && dec.entryPrice != null) {
    const gain = dec.entryPrice > 0 ? dec.price / dec.entryPrice - 1 : 0;
    if (gain >= 0 && dec.takeProfitPct - gain > 0)
      return `保有中だよ。今は${signedPct(gain)}、利確まであと${fmtPercent(dec.takeProfitPct - gain)}だね`;
    if (gain < 0 && gain + dec.stopLossPct > 0)
      return `保有中だよ。今は${signedPct(gain)}、損切りまであと${fmtPercent(gain + dec.stopLossPct)}だね`;
    return `保有中だよ。取得${price(dec.entryPrice)}から今は${signedPct(gain)}だね`;
  }
  return waitNarration(dec, prev);
}

/**
 * Empirical per-condition distance, on the same scales as
 * trailDistance (EMA gap as a share of price, RSI points above the
 * oversold line, negated histogram). Used ONLY as the watch's own
 * baseline: the current value is compared against the value recorded
 * at declaration time, never shown as a number of its own.
 */
function watchDistance(key: EntryCondKey, dec: DecisionTelemetry): number {
  if (key === "emaUp")
    return dec.price > 0 ? (dec.ema50 - dec.ema20) / dec.price : 0;
  if (key === "rsiRecovery") return dec.rsi - dec.oversold;
  return -dec.histogram;
}

/** Current distance as a ratio of the declared baseline. */
function watchRatio(watch: WatchTarget, dec: DecisionTelemetry): number {
  const current = watchDistance(watch.key, dec);
  if (watch.declaredDistance <= 0) return current <= 0 ? 0 : 1;
  return current / watch.declaredDistance;
}

/** The approach call-out fires once, at half the declared distance. */
export const WATCH_APPROACH_RATIO = 0.5;
/**
 * Withdrawal hysteresis: the watched condition must drift beyond
 * 125% of its declared distance before the declaration is dropped,
 * so small wobbles never flap declare/withdraw back and forth.
 */
export const WATCH_WITHDRAW_RATIO = 1.25;

/**
 * Review milestone: a ふりかえり look-back is told once this many
 * watch settlements have piled up since the previous review — or
 * sooner, when a BUY closes a chapter (see REVIEW_BUY_MIN_SETTLED).
 * Settlements are never reviewed one by one.
 */
export const REVIEW_SETTLED_THRESHOLD = 3;
/** A BUY milestone reviews early only with at least this many
 * settlements still unreviewed. */
export const REVIEW_BUY_MIN_SETTLED = 2;

/** Spike alerts compare the current decision price against the one
 * this many narrated cycles back. */
export const ALERT_PRICE_LOOKBACK = 3;
/** A price move of at least this ratio (±1%) against the look-back
 * price is alert-worthy. */
export const ALERT_PRICE_THRESHOLD = 0.01;
/**
 * The recorded volume change is a ratio — the newest candle's
 * volume over the previous one's, minus one (see the indicators
 * package) — so this volume-spike threshold of 2 means the change
 * `fmtPercent` would print as +200%.
 */
export const ALERT_VOLUME_THRESHOLD = 2;
/** After an alert fires, this many narrated cycles pass before the
 * next one may fire. Counted in decision cycles, never in polls. */
export const ALERT_COOLDOWN_CYCLES = 5;
/** The buy-run line's one approaching murmur fires when the price
 * closes to within this percent of the line (a negative distance:
 * the line sits below the price until it is touched). */
export const PRICE_LINE_MURMUR_PCT = -1.5;
/** Price points kept for the alert look-back (only the newest
 * ALERT_PRICE_LOOKBACK + 1 are ever consulted). */
const ALERT_HISTORY_KEEP = 12;

/**
 * The closest unmet entry condition, by the same normalised
 * `unmetDistance` the cycle narration already uses to pick what to
 * talk about — the watch invents no ruler of its own. Ties keep the
 * display order (EMA, RSI, MACD). `exclude` bars instantly
 * re-declaring a target that was just withdrawn.
 */
function chooseWatchTarget(
  dec: DecisionTelemetry,
  exclude?: EntryCondKey,
): EntryCondKey | null {
  const unmet = entryConditions(dec).filter((c) => !c.met && c.key !== exclude);
  if (!unmet.length) return null;
  return unmet.reduce((a, b) =>
    unmetDistance(dec, b.key) < unmetDistance(dec, a.key) ? b : a,
  ).key;
}

function makeWatch(key: EntryCondKey, dec: DecisionTelemetry): WatchTarget {
  const declaredDistance = watchDistance(key, dec);
  return { key, declaredDistance, called: false, closestDistance: declaredDistance };
}

/** A watch only lives while the bot is flat and still hunting. */
function watchEligible(dec: DecisionTelemetry): boolean {
  return (
    dec.action === "WAIT" &&
    !dec.conditions.hasPosition &&
    metEntryConditions(dec) < 3
  );
}

const WATCH_NAME: Record<EntryCondKey, string> = {
  emaUp: "EMAの差",
  rsiRecovery: "RSI",
  histogramImproving: "MACD",
};

/** Current-value phrase for a watch target ("今-0.38%", "今29で圏内"…). */
function watchValue(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp") return `今${emaGapPct(dec)}`;
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? `今${fmtNumber(dec.rsi, 1)}で圏内`
      : `今${fmtNumber(dec.rsi, 1)}、ラインまで${rsiPoints(dec.rsi, dec.oversold)}`;
  return `今${fmtNumber(dec.histogram, 4)}`;
}

function declareWatchText(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp")
    return `次はEMAの差を見てる。今${emaGapPct(dec)}、縮んできたら声かけるね`;
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? `次はRSIを見てる。今${fmtNumber(dec.rsi, 1)}で圏内、上抜けたら声かけるね`
      : `次はRSIを見てる。今${fmtNumber(dec.rsi, 1)}、ラインまで${rsiPoints(dec.rsi, dec.oversold)}。近づいたら声かけるね`;
  return `次はMACDを見てる。今${fmtNumber(dec.histogram, 4)}、プラスに転じたら声かけるね`;
}

function approachWatchText(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp")
    return `EMAの差、${emaGapPct(dec)}まで縮んだ。宣言してたやつ、来てるよ`;
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? "RSI、圏内まで来たよ。宣言してたやつ、上抜け待ちだね"
      : `RSI、ラインまで${rsiPoints(dec.rsi, dec.oversold)}まで来た。宣言してたやつ、来てるよ`;
  return `MACD、${fmtNumber(dec.histogram, 4)}まで戻った。宣言してたやつ、来てるよ`;
}

/**
 * The hit line: the recorded facts stay exactly as measured, and
 * the close turns smug — the Kansai catchphrase 「ほらな、言うてた
 * やろ」, the counterpart of the near-miss line's dialect slip.
 */
function hitWatchText(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp")
    return dec.conditions.emaGapShrinking
      ? `EMA、成立した。${fmtNumber(dec.ema20, 4)}はまだ${fmtNumber(dec.ema50, 4)}の下、差の縮小が続いての成立。ほらな、言うてたやろ`
      : `EMA、成立した。${fmtNumber(dec.ema20, 4)}が${fmtNumber(dec.ema50, 4)}の上。ほらな、言うてたやろ`;
  if (key === "rsiRecovery")
    return `RSI、上抜けた。${fmtNumber(dec.previousRsi, 1)}→${fmtNumber(dec.rsi, 1)}。ほらな、言うてたやろ`;
  return `MACD、成立した。今${fmtNumber(dec.histogram, 4)}。ほらな、言うてたやろ`;
}

function withdrawWatchText(key: EntryCondKey): string {
  if (key === "emaUp")
    return "注目してたEMAの差、開いてきたなあ。宣言は取り下げ";
  if (key === "rsiRecovery")
    return "注目してたRSI、遠のいたなあ。宣言は取り下げ";
  return "注目してたMACD、遠のいたなあ。宣言は取り下げ";
}

/**
 * The near-miss line for a called watch that slipped away, naming
 * the closest distance reached while watching (converted back to
 * each condition's own scale). This is the one line told in Kansai
 * dialect — the disappointment leaks out of the usual voice.
 */
function nearMissText(key: EntryCondKey, closestDistance: number): string {
  if (key === "emaUp")
    return `EMAの差、${fmtPercent(-closestDistance)}まで詰めてたのに、また開いてきたわ…`;
  if (key === "rsiRecovery")
    return `RSI、あと${Math.max(0, Math.round(closestDistance))}まで来てたのに…なんで離れるねん`;
  return `MACD、${fmtNumber(-closestDistance, 4)}まで戻してたのに、また下がってもうたわ…`;
}

/** Sleep talk cadence: the first mutter comes this long after the
 * sleep begins, and later mutters keep at least this much space. */
export const SLEEP_TALK_INTERVAL_MS = 15 * 60_000;

/**
 * Sleep-talk candidates, in the order the sleeping character would
 * reach for them: the session's near miss first, then a told hit,
 * a recorded buy, a miss that was never a near miss — and always
 * the fact-free dream mutters about SUI itself as the fallback.
 * Every factual line is built only from what the state recorded;
 * the caller picks the first candidate that is not a repeat of
 * the previous mutter.
 */
function sleepTalkCandidates(state: {
  lastNearMiss: NarrationState["lastNearMiss"];
  lastHitAt: number | null;
  entries: NarrationEntry[];
  watchScore: WatchScore;
}): string[] {
  const out: string[] = [];
  const nm = state.lastNearMiss;
  if (nm) {
    if (nm.key === "rsiRecovery")
      out.push(
        `RSIがあと${Math.max(0, Math.round(nm.closestDistance))}やったのに…むにゃ…`,
      );
    else if (nm.key === "emaUp")
      out.push(
        `EMAの差、${fmtPercent(-nm.closestDistance)}までいってたのに…むにゃ…`,
      );
    else out.push("MACD、あと少しやったのに…むにゃ…");
  }
  if (state.lastHitAt != null) out.push("ほらなって…言うたやろ…むにゃ…");
  if (state.entries.some((e) => e.kind === "trade" && e.side === "BUY"))
    out.push("買えたやつ…上がれ…むにゃ…");
  if (state.watchScore.misses > 0 && !nm) out.push("次は当てる…むにゃ…");
  out.push("すい…すい…", "むにゃ…すい…上がれ…");
  return out;
}

interface WatchOutcome {
  /** Drafts told before the cycle's own narration (declare / call /
   * hit / withdraw / switch). */
  before: EntryDraft[];
  /** Drafts told after it (the next declaration following a hit). */
  after: EntryDraft[];
  watch: WatchTarget | null;
  /** A new watch was declared this cycle (scores one declaration). */
  created: boolean;
  /** How the previous watch settled this cycle, if it did: "hit"
   * when the watched condition clicked while watched, "miss" when
   * it was withdrawn for drifting away. A watch that ends silently
   * (position opened, material gone) settles as null — neither. */
  settled: "hit" | "miss" | null;
  /** Set when this cycle TOLD a near miss: its key and the closest
   * distance reached, kept as the sleep talk's material. */
  nearMiss: { key: EntryCondKey; closestDistance: number } | null;
}

/**
 * Advance the declared watch by one narrated cycle. The caller has
 * already established that the decision is fresh, the bot is awake,
 * and the watch may live (see watchEligible for when it silently
 * ends instead: a fill, a position, or all conditions met are told
 * by their own narration, so the watch never talks over them).
 */
function processWatch(
  current: WatchTarget | null,
  dec: DecisionTelemetry,
): WatchOutcome {
  const draft = (text: string, kind: NarrationKind = "cycle"): EntryDraft => ({
    at: dec.evaluatedAt,
    kind,
    text,
  });
  if (!watchEligible(dec))
    // The watch ends here. If the watched condition clicked in this
    // very decision — the last condition falling into place for a
    // BUY, or all three met — that still counts as a hit; any other
    // silent end (a position opened, the hunt is over) is neither a
    // hit nor a miss.
    return {
      before: [],
      after: [],
      watch: null,
      created: false,
      settled: current && dec.conditions[current.key] ? "hit" : null,
      nearMiss: null,
    };

  if (current && dec.conditions[current.key]) {
    // 的中: tie the click back to the declaration, then declare the
    // next watch right away (told after the cycle's own line).
    const next = chooseWatchTarget(dec);
    return {
      before: [draft(hitWatchText(current.key, dec), "watchHit")],
      after: next
        ? [
            draft(
              `次の注目は${WATCH_NAME[next]}に決めた。${watchValue(next, dec)}だよ`,
            ),
          ]
        : [],
      watch: next ? makeWatch(next, dec) : null,
      created: next != null,
      settled: "hit",
      nearMiss: null,
    };
  }

  if (current) {
    const ratio = watchRatio(current, dec);
    const closest = Math.min(
      current.closestDistance,
      watchDistance(current.key, dec),
    );
    if (ratio > WATCH_WITHDRAW_RATIO) {
      // A watch that had its approach called really did come close:
      // its withdrawal is told as a near miss, naming how close it
      // got. One that never came close keeps the plain withdrawal.
      const before = [
        current.called
          ? draft(nearMissText(current.key, closest), "nearMiss")
          : draft(withdrawWatchText(current.key)),
      ];
      const next = chooseWatchTarget(dec, current.key);
      if (next)
        before.push(
          draft(
            `注目は${WATCH_NAME[next]}に切り替える。${watchValue(next, dec)}だよ`,
          ),
        );
      return {
        before,
        after: [],
        watch: next ? makeWatch(next, dec) : null,
        created: next != null,
        settled: "miss",
        nearMiss: current.called
          ? { key: current.key, closestDistance: closest }
          : null,
      };
    }
    if (!current.called && ratio <= WATCH_APPROACH_RATIO)
      return {
        before: [draft(approachWatchText(current.key, dec))],
        after: [],
        watch: { ...current, called: true, closestDistance: closest },
        created: false,
        settled: null,
        nearMiss: null,
      };
    return {
      before: [],
      after: [],
      watch: { ...current, closestDistance: closest },
      created: false,
      settled: null,
      nearMiss: null,
    };
  }

  const target = chooseWatchTarget(dec);
  return target
    ? {
        before: [draft(declareWatchText(target, dec))],
        after: [],
        watch: makeWatch(target, dec),
        created: true,
        settled: null,
        nearMiss: null,
      }
    : { before: [], after: [], watch: null, created: false, settled: null, nearMiss: null };
}

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

/**
 * The buy-condition chips (EMA / RSI / MACD only), derived from the
 * same evidence as the narration so the two can never disagree.
 * Status words use recorded values only: the EMA gap as a share of
 * price, whole RSI points to the oversold line, the histogram against
 * a small ATR window — and "後退" when the condition was met in the
 * previous cycle and has since broken.
 */
export function entryConditionChips(
  dec: DecisionTelemetry,
  prev: DecisionTrail | null,
): EntryConditionChip[] {
  const emaGap = dec.price > 0 ? (dec.ema50 - dec.ema20) / dec.price : 1;
  const ema: EntryConditionChip = dec.conditions.emaUp
    ? {
        key: "ema",
        label: "EMA",
        met: true,
        status: "✓",
        tone: "met",
        watching: false,
      }
    : prev?.emaUp
      ? {
          key: "ema",
          label: "EMA",
          met: false,
          status: "後退",
          tone: "back",
          watching: false,
        }
      : emaGap <= 0.003
        ? {
            key: "ema",
            label: "EMA",
            met: false,
            status: "あと少し",
            tone: "close",
            watching: false,
          }
        : {
            key: "ema",
            label: "EMA",
            met: false,
            status: "逆並び",
            tone: "far",
            watching: false,
          };
  const points = rsiPoints(dec.rsi, dec.oversold);
  const rsi: EntryConditionChip = dec.conditions.rsiRecovery
    ? {
        key: "rsi",
        label: "RSI",
        met: true,
        status: "✓",
        tone: "met",
        watching: false,
      }
    : prev?.rsiRecovery
      ? {
          key: "rsi",
          label: "RSI",
          met: false,
          status: "後退",
          tone: "back",
          watching: false,
        }
      : dec.rsi <= dec.oversold
        ? {
            key: "rsi",
            label: "RSI",
            met: false,
            status: "圏内",
            tone: "close",
            watching: false,
          }
        : {
            key: "rsi",
            label: "RSI",
            met: false,
            status: `あと${points}`,
            detail: `あと${points}`,
            tone: points <= 3 ? "close" : "far",
            watching: false,
          };
  const macd: EntryConditionChip = dec.conditions.histogramImproving
    ? {
        key: "macd",
        label: "MACD",
        met: true,
        status: "✓",
        tone: "met",
        watching: false,
      }
    : prev?.histogramImproving
      ? {
          key: "macd",
          label: "MACD",
          met: false,
          status: "後退",
          tone: "back",
          watching: false,
        }
      : dec.histogram < 0 &&
          dec.atr > 0 &&
          Math.abs(dec.histogram) <= dec.atr * 0.05
        ? {
            key: "macd",
            label: "MACD",
            met: false,
            status: "あと1",
            tone: "close",
            watching: false,
          }
        : dec.histogram < 0
          ? {
              key: "macd",
              label: "MACD",
              met: false,
              status: "マイナス",
              tone: "far",
              watching: false,
            }
          : {
              key: "macd",
              label: "MACD",
              met: false,
              status: "下向き",
              tone: "far",
              watching: false,
            };
  return [ema, rsi, macd];
}

const CHIP_KEY_OF_WATCH: Record<EntryCondKey, EntryConditionChip["key"]> = {
  emaUp: "ema",
  rsiRecovery: "rsi",
  histogramImproving: "macd",
};

/**
 * Chips for the snapshot on screen: null unless the decision is
 * fresh (a stale display shows no chips, like it tells no narration).
 * The "previous" trail is whichever decision came right before the
 * one on screen, whether or not the feed has consumed it yet.
 */
export function currentConditionChips(
  state: NarrationState,
  dec: DecisionTelemetry | null | undefined,
  now: number,
): EntryConditionChip[] | null {
  if (!dec || !freshDecision(dec, now)) return null;
  let prev: DecisionTrail | null = null;
  if (state.lastTrail) {
    if (dec.evaluatedAt === state.lastTrail.evaluatedAt) prev = state.prevTrail;
    else if (dec.evaluatedAt > state.lastTrail.evaluatedAt)
      prev = state.lastTrail;
    else prev = state.prevTrail;
  }
  const chips = entryConditionChips(dec, prev);
  if (state.watch)
    for (const chip of chips)
      if (chip.key === CHIP_KEY_OF_WATCH[state.watch.key] && !chip.met)
        chip.watching = true;
  return chips;
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

const JUST_DECLARED_DETAIL: Record<EntryCondKey, string> = {
  emaUp: "宣言したところ。縮んだら声かける",
  rsiRecovery: "宣言したところ。上抜け待ち",
  histogramImproving: "宣言したところ。プラス転換待ち",
};

/**
 * The "いまの注目" strip for the snapshot on screen: null unless the
 * decision is fresh (same fail-closed rule as the chips). When the
 * bot is stopped, holding, or all conditions are met, there is no
 * watch and the strip says so with the reason; otherwise it shows
 * the declared target — or, for a snapshot the feed has not consumed
 * yet, the target the declaration rule would pick — with its current
 * value and how it has moved since the declaration.
 */
export function currentWatch(
  state: NarrationState,
  dec: DecisionTelemetry | null | undefined,
  vitalState: VitalState,
  now: number,
): WatchDisplay | null {
  if (!dec || !freshDecision(dec, now)) return null;
  if (vitalState === "sleeping" || vitalState === "flatlined")
    return {
      key: null,
      label: "なし",
      value: "",
      detail: "止まってるから注目はお休み",
    };
  if (dec.conditions.hasPosition)
    return {
      key: null,
      label: "なし",
      value: "",
      detail: "保有中。条件が崩れたら声かける",
    };
  if (metEntryConditions(dec) === 3)
    return {
      key: null,
      label: "なし",
      value: "",
      detail: "3つ揃ったので注目は終了",
    };
  const declared =
    state.watch && !dec.conditions[state.watch.key] ? state.watch : null;
  const key = declared ? declared.key : chooseWatchTarget(dec);
  if (!key) return null;
  let detail: string;
  if (declared) {
    const ratio = watchRatio(declared, dec);
    detail =
      declared.declaredDistance > 0 && ratio <= WATCH_APPROACH_RATIO
        ? "宣言時の半分以下。来てる"
        : ratio < 1
          ? "宣言時より縮んだ"
          : ratio > 1
            ? "少し遠のいたけど様子見"
            : JUST_DECLARED_DETAIL[key];
  } else {
    detail = "いちばん届きそうなやつを見てる";
  }
  return { key, label: WATCH_NAME[key], value: watchValue(key, dec), detail };
}

export interface WatchScoreDisplay {
  declared: number;
  hits: number;
  misses: number;
  /** 1 while a watch is live, otherwise 0. */
  inProgress: number;
}

/**
 * The score strip for the snapshot on screen: null unless the
 * decision is fresh (the same fail-closed rule as the chips and the
 * watch strip). The counts are the session's cumulative record;
 * 進行中 simply mirrors whether a watch is live right now.
 */
export function currentWatchScore(
  state: NarrationState,
  dec: DecisionTelemetry | null | undefined,
  now: number,
): WatchScoreDisplay | null {
  if (!dec || !freshDecision(dec, now)) return null;
  return {
    declared: state.watchScore.declared,
    hits: state.watchScore.hits,
    misses: state.watchScore.misses,
    inProgress: state.watch ? 1 : 0,
  };
}

const reviewPrice = (v: number) => `$${fmtNumber(v, 3)}`;

/** Review lines keep the move readable: one decimal place, signed. */
const reviewPct = (ratio: number) =>
  `${ratio > 0 ? "+" : ""}${new Intl.NumberFormat("ja-JP", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(ratio)}`;

/**
 * The ふりかえり look-back lines, built ONLY from the recorded
 * session facts handed in: the cumulative declaration score and the
 * price move from the session's first evidence to now. A missing or
 * unusable price omits the price line entirely — the review never
 * invents a move it did not record. The verdict follows the recorded
 * hit/miss balance, nothing else.
 */
export function reviewNarrationTexts(
  score: { declared: number; hits: number; misses: number },
  startPrice: number | null,
  currentPrice: number | null,
  buyMilestone: boolean,
): string[] {
  const verdict =
    score.hits > score.misses
      ? "悪くないね"
      : score.misses > score.hits
        ? "外れが多めだなあ"
        : score.hits > 0
          ? "五分五分だね"
          : "まだ決着なしだね";
  const lines = [
    `ふりかえり。ここまでの宣言は${score.declared}回、的中${score.hits}回、外れ${score.misses}回。${verdict}`,
  ];
  if (
    startPrice != null &&
    currentPrice != null &&
    Number.isFinite(startPrice) &&
    Number.isFinite(currentPrice) &&
    startPrice > 0
  ) {
    const change = currentPrice / startPrice - 1;
    const tail = buyMilestone
      ? "最後は3つ揃ったよ"
      : change > 0.001
        ? "上がってきたね"
        : change < -0.001
          ? "少し下げてるね"
          : "ほぼ横ばいだね";
    lines.push(
      `価格は${reviewPrice(startPrice)}から${reviewPrice(currentPrice)}、${reviewPct(change)}。${tail}`,
    );
  }
  return lines;
}

export interface SpikeAlert {
  direction: SpikeAlertDirection;
  text: string;
}

/**
 * Alert price moves always print with exactly one decimal place
 * ("+1.8%", "-1.0%"). The volume change inside an alert keeps the
 * feed's existing volume style (`signedPct`: "+250%", "+350%"),
 * the same shape the VOLUME_REJECT line already prints — except
 * when the recorded change is huge, where both lines switch to a
 * multiple instead (see `volumeMultiple`).
 */
const alertPct = (ratio: number) =>
  `${ratio > 0 ? "+" : ""}${new Intl.NumberFormat("ja-JP", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ratio)}`;

/**
 * Detect a spike worth breaking in for, from the recorded evidence
 * alone: the decision prices of the narrated cycles before this one
 * (`history`, oldest first, not yet including `dec`) and this
 * cycle's own decision. Returns null — silence — when:
 * - the price history has not warmed up (fewer than
 *   ALERT_PRICE_LOOKBACK earlier points, so no four-point move can
 *   be stated);
 * - the price or volume change is missing, non-finite, or unusable;
 * - neither the ±1% price move nor the +200% volume change fired.
 * When the price and the volume spike in the same cycle the alert is
 * a single entry mentioning both. A volume spike the cycle's own
 * narration already reports (a VOLUME_REJECT cycle prints the change
 * itself) is never repeated: on such a cycle only a price move can
 * still alert, and its text leaves the volume out.
 */
export function spikeAlert(
  history: readonly number[],
  dec: DecisionTelemetry,
): SpikeAlert | null {
  if (history.length < ALERT_PRICE_LOOKBACK) return null;
  if (!Number.isFinite(dec.price) || dec.price <= 0) return null;
  const base = history[history.length - ALERT_PRICE_LOOKBACK];
  if (!Number.isFinite(base) || base <= 0) return null;
  const ratio = dec.price / base - 1;
  const priceUp = ratio >= ALERT_PRICE_THRESHOLD;
  const priceDown = ratio <= -ALERT_PRICE_THRESHOLD;
  const volumeSpike =
    Number.isFinite(dec.volumeChange) &&
    dec.volumeChange >= ALERT_VOLUME_THRESHOLD &&
    dec.selectedRule !== "VOLUME_REJECT";
  if (!priceUp && !priceDown && !volumeSpike) return null;
  if (priceUp)
    return {
      direction: "up",
      text: volumeSpike
        ? `速報。SUI、短時間で${alertPct(ratio)}。出来高の変化も跳ねた`
        : `速報。SUI、短時間で${alertPct(ratio)}。急に来た`,
    };
  if (priceDown)
    return {
      direction: "down",
      text: volumeSpike
        ? `速報。SUI、${alertPct(ratio)}。急落だ。出来高の変化も跳ねたから、ちょっと様子見る`
        : `速報。SUI、${alertPct(ratio)}。急落だ。ちょっと様子見る`,
    };
  const multiple = volumeMultiple(dec.volumeChange);
  return {
    direction: "volume",
    text:
      multiple != null
        ? `速報。出来高が約${multiple}倍に跳ねた。何かあったかも`
        : Number.isFinite(dec.volumeChange)
          ? `速報。出来高の変化が${signedPct(dec.volumeChange)}に跳ねた。何かあったかも`
          : `速報。出来高の変化が跳ねた。何かあったかも`,
  };
}

type EntryDraft = Omit<NarrationEntry, "id">;

function eventKey(e: OperationsSnapshot["events"][number]): string {
  return `e:${e.timestamp}:${e.kind}:${e.code}:${e.apiFailure?.api ?? ""}:${e.apiFailure?.operation ?? ""}:${e.apiFailure?.code ?? ""}`;
}
function candidateKey(c: OperationsSnapshot["candidates"][number]): string {
  return `c:${c.createdAt}:${c.id}:${c.finalAction}`;
}

function stopReasonText(d: OperationsSnapshot): string {
  return operationReason(d.stopReason ?? d.safety?.lastStopReason ?? "UNKNOWN");
}

function initialEntry(
  d: OperationsSnapshot,
  vitalState: VitalState,
  now: number,
): EntryDraft {
  if (vitalState === "flatlined")
    return {
      at: now,
      kind: "stop",
      text: `安全停止中だよ。理由：${stopReasonText(d)}`,
    };
  if (vitalState === "sleeping")
    return d.stopReason
      ? {
          at: now,
          kind: "stop",
          text: `停止中だよ。理由：${stopReasonText(d)}`,
        }
      : {
          at: now,
          kind: "status",
          text: "停止中だよ。開始操作を待ってるね",
        };
  if (vitalState === "alive" || vitalState === "weak") {
    const dec = d.decision;
    if (dec && freshDecision(dec, now))
      return {
        at: dec.evaluatedAt,
        kind: "cycle",
        text: cycleNarrationText(dec, null),
      };
    return {
      at: now,
      kind: "status",
      text: "稼働中だよ。新しい記録が届くのを待ってるね",
    };
  }
  return {
    at: now,
    kind: "status",
    text: "状態を確認中だよ。記録が届くまで実況は止まるね",
  };
}

/**
 * Advance the feed by one snapshot. Pure: returns a new state and
 * never mutates the previous one. New facts are recognised by dedupe
 * keys (events, candidates) and by the decision's evaluatedAt, so
 * re-rendering the same snapshot — or a frozen one — adds nothing.
 */
export function advanceNarration(
  prev: NarrationState,
  d: OperationsSnapshot,
  vitalState: VitalState,
  now: number,
): NarrationState {
  const seen = new Set(prev.seen);
  const pending = new Set(prev.pendingCandidateIds);
  const drafts: EntryDraft[] = [];
  let narratedStop = false;
  let narratedPaused = false;
  let narratedRecovered = false;

  if (!prev.initialized) {
    for (const e of d.events ?? []) {
      seen.add(eventKey(e));
    }
    for (const c of d.candidates ?? []) {
      seen.add(candidateKey(c));
      if (c.finalAction === "PENDING") pending.add(c.id);
    }
    drafts.push(initialEntry(d, vitalState, now));
    // The first watch is set silently: the declaration is only
    // narrated when the target changes, never on page load. It still
    // counts as a declaration on the score, like in the prototype.
    let firstWatch: WatchTarget | null = null;
    let firstScore = prev.watchScore;
    const firstDec = d.decision;
    if (
      (vitalState === "alive" || vitalState === "weak") &&
      firstDec &&
      freshDecision(firstDec, now) &&
      watchEligible(firstDec)
    ) {
      const target = chooseWatchTarget(firstDec);
      if (target) {
        firstWatch = makeWatch(target, firstDec);
        firstScore = { ...firstScore, declared: firstScore.declared + 1 };
      }
    }
    // The buy-run line is likewise adopted silently on page load:
    // only a line that appears while the feed is open is declared.
    const firstLine =
      (vitalState === "alive" || vitalState === "weak") &&
      firstDec &&
      freshDecision(firstDec, now)
        ? (firstDec.rsiLinePrice ?? null)
        : null;
    const firstPriceLine =
      firstLine != null && firstDec
        ? {
            price: firstLine,
            reached: firstDec.price <= firstLine,
            murmured:
              firstDec.price <= firstLine ||
              (firstLine / firstDec.price - 1) * 100 >= PRICE_LINE_MURMUR_PCT,
          }
        : null;
    return finish(
      {
        ...prev,
        watch: firstWatch,
        watchScore: firstScore,
        priceLine: firstPriceLine,
        // The first recorded decision seeds the spike alerts' price
        // history — but only when it is fresh evidence; a stale
        // first snapshot warms the alerts up from zero instead.
        priceHistory:
          firstDec &&
          freshDecision(firstDec, now) &&
          Number.isFinite(firstDec.price) &&
          firstDec.price > 0
            ? [firstDec.price]
            : [],
        sessionStartPrice: prev.sessionStartPrice ?? firstDec?.price ?? null,
        seen: [...seen],
        pendingCandidateIds: [...pending].slice(-50),
        lastDecisionAt: d.decision?.evaluatedAt ?? null,
        prevDecisionPrice: d.decision?.price ?? null,
        lastTrail: d.decision ? decisionTrail(d.decision) : null,
        prevTrail: null,
        lastConnectivity: d.safety?.connectivity ?? null,
        lastStatus: d.status ?? null,
        // Opening the feed on an already-sleeping bot starts its
        // sleep here, so the first mutter still waits a full
        // interval instead of arriving with the page.
        sleepingSince: vitalState === "sleeping" ? now : null,
        initialized: true,
      },
      drafts,
    );
  }

  // --- operation events, oldest first -------------------------------
  const events = [...(d.events ?? [])].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const apiTimestamps = new Set(
    events.filter((e) => e.kind === "API").map((e) => e.timestamp),
  );
  for (const e of events) {
    const key = eventKey(e);
    if (seen.has(key)) {
      seen.delete(key);
      seen.add(key);
      continue;
    }
    if (
      prev.retiredEventThrough != null &&
      e.timestamp <= prev.retiredEventThrough
    )
      continue;
    seen.add(key);
    if (e.kind === "STOP") {
      narratedStop = true;
      drafts.push({
        at: e.timestamp,
        kind: "stop",
        text:
          e.code === "MANUAL_STOP"
            ? "手動で止められたよ"
            : `止まったよ。理由：${operationReason(e.code)}`,
      });
    } else if (e.kind === "BOOT") {
      drafts.push({
        at: e.timestamp,
        kind: "status",
        text: "再起動したよ。開始は手動操作待ちだね",
      });
    } else if (e.kind === "CONTROL") {
      if (e.code === "MANUAL_START") {
        drafts.push({
          at: e.timestamp,
          kind: "start",
          text: "PAPER運用を始めたよ",
        });
      } else if (e.code === "PAPER_NETWORK_RECOVERED") {
        narratedRecovered = true;
        drafts.push({
          at: e.timestamp,
          kind: "recovery",
          text: "通信が戻ったよ。PAPER運用を再開するね",
        });
      } else if (e.code === "PAPER_NETWORK_PAUSED") {
        narratedPaused = true;
        drafts.push({
          at: e.timestamp,
          kind: "warning",
          text: "通信がおかしいから、注文を一時停止したよ",
        });
      } else if (e.code === "MANUAL_RESET") {
        drafts.push({
          at: e.timestamp,
          kind: "status",
          text: "停止状態が解除されたよ",
        });
      }
    } else if (e.kind === "API" && e.apiFailure) {
      drafts.push({
        at: e.timestamp,
        kind: "warning",
        text: `${e.apiFailure.api}と通信できなかったよ（${operationReason(e.apiFailure.code)}）`,
      });
    } else if (e.kind === "ANOMALY" && e.fatal) {
      drafts.push({
        at: e.timestamp,
        kind: "warning",
        text: `異常を検出したよ：${operationReason(e.code)}`,
      });
    } else if (e.kind === "ERROR" && !apiTimestamps.has(e.timestamp)) {
      // An API event at the same timestamp already told this story.
      drafts.push({
        at: e.timestamp,
        kind: "warning",
        text: `処理でエラーが出たよ：${operationReason(e.code)}`,
      });
    }
    // WAIT events are covered by the richer cycle narration below.
  }

  // --- candidate audits, oldest first --------------------------------
  const candidates = [...(d.candidates ?? [])].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  for (const c of candidates) {
    const key = candidateKey(c);
    const wasPending = pending.has(c.id);
    if (c.finalAction !== "PENDING") pending.delete(c.id);
    if (seen.has(key)) {
      seen.delete(key);
      seen.add(key);
      continue;
    }
    if (
      !wasPending &&
      prev.retiredCandidateThrough != null &&
      c.createdAt <= prev.retiredCandidateThrough
    )
      continue;
    if (c.finalAction === "PENDING") pending.add(c.id);
    seen.add(key);
    const qty =
      c.quantityAtomic != null && Number.isFinite(Number(c.quantityAtomic))
        ? `${fmtNumber(Number(c.quantityAtomic) / 1e9, 9)} SUI`
        : null;
    const quote =
      c.quotePriceUsdc != null
        ? `${fmtNumber(c.quotePriceUsdc, 4)} USDC`
        : null;
    const fill = [qty, quote ? `見積もり価格 ${quote}` : null]
      .filter(Boolean)
      .join("・");
    if (c.finalAction === "BUY" || c.finalAction === "SELL") {
      drafts.push({
        at: c.timestamp,
        kind: "trade",
        side: c.finalAction,
        text: `PAPERで${c.finalAction === "BUY" ? "買い" : "売り"}を記録したよ${fill ? `：${fill}` : ""}`,
      });
    } else if (c.finalAction === "WAIT") {
      const reason = c.reasons[0]
        ? operationReason(c.reasons[0])
        : "条件を確認できなかった";
      drafts.push({
        at: c.timestamp,
        kind: "rejection",
        text: `${c.side === "BUY" ? "買い" : "売り"}シグナルは出たけど、見送ったよ（${reason}）`,
      });
    } else if (c.finalAction === "SAFE_STOP") {
      narratedStop = true;
      const reason = c.reasons[0]
        ? operationReason(c.reasons[0])
        : "安全条件を確認できなかった";
      drafts.push({
        at: c.timestamp,
        kind: "stop",
        text: `候補の処理中に安全停止したよ（${reason}）`,
      });
    }
    // PENDING candidates are not final yet: stay silent.
  }

  // --- strategy cycle, from the decision evidence --------------------
  let lastDecisionAt = prev.lastDecisionAt;
  let prevDecisionPrice = prev.prevDecisionPrice;
  let lastTrail = prev.lastTrail;
  let prevTrail = prev.prevTrail;
  let priceRising = prev.priceRising;
  let watch = prev.watch;
  let watchScore = prev.watchScore;
  let sessionStartPrice = prev.sessionStartPrice;
  let priceHistory = prev.priceHistory;
  let alertCooldown = prev.alertCooldown;
  let lastAlert = prev.lastAlert;
  let lastHitAt = prev.lastHitAt;
  let lastNearMiss = prev.lastNearMiss;
  let priceLine = prev.priceLine;
  let sleepingSince = prev.sleepingSince;
  let lastSleepTalkAt = prev.lastSleepTalkAt;
  let lastSleepTalkText = prev.lastSleepTalkText;
  const dec = d.decision;
  if (dec && (lastDecisionAt == null || dec.evaluatedAt > lastDecisionAt)) {
    if (sessionStartPrice == null) sessionStartPrice = dec.price;
    if (
      (vitalState === "alive" || vitalState === "weak") &&
      freshDecision(dec, now)
    ) {
      // The declared watch advances with the same cycle: its lines
      // frame the cycle's own narration (before / after).
      const outcome = processWatch(watch, dec);
      watch = outcome.watch;
      if (outcome.before.some((draft) => draft.kind === "watchHit"))
        lastHitAt = dec.evaluatedAt;
      if (outcome.nearMiss) lastNearMiss = outcome.nearMiss;
      drafts.push(...outcome.before);
      drafts.push({
        at: dec.evaluatedAt,
        kind: "cycle",
        text: cycleNarrationText(dec, lastTrail),
      });
      // A sudden market move breaks in right after the cycle's own
      // line: it is market news alongside the decision, never a
      // replacement for it. The price joins the look-back history
      // either way; while the cooldown from the last alert runs,
      // this cycle stays silent and counts the cooldown down.
      if (alertCooldown > 0) {
        alertCooldown -= 1;
      } else {
        const alert = spikeAlert(priceHistory, dec);
        if (alert) {
          drafts.push({
            at: dec.evaluatedAt,
            kind: "alert",
            text: alert.text,
          });
          lastAlert = { at: dec.evaluatedAt, direction: alert.direction };
          alertCooldown = ALERT_COOLDOWN_CYCLES;
        }
      }
      if (Number.isFinite(dec.price) && dec.price > 0)
        priceHistory = [...priceHistory, dec.price].slice(-ALERT_HISTORY_KEEP);
      drafts.push(...outcome.after);
      // Score the cycle's declaration / settlement, then — only at
      // a milestone — pause for a short look-back over the record.
      const settled = outcome.settled != null;
      watchScore = {
        declared: watchScore.declared + (outcome.created ? 1 : 0),
        hits: watchScore.hits + (outcome.settled === "hit" ? 1 : 0),
        misses: watchScore.misses + (outcome.settled === "miss" ? 1 : 0),
        unreviewed: watchScore.unreviewed + (settled ? 1 : 0),
      };
      const buyMilestone = dec.action === "BUY";
      if (
        watchScore.unreviewed >= REVIEW_SETTLED_THRESHOLD ||
        (buyMilestone && watchScore.unreviewed >= REVIEW_BUY_MIN_SETTLED)
      ) {
        for (const text of reviewNarrationTexts(
          watchScore,
          sessionStartPrice,
          dec.price,
          buyMilestone,
        ))
          drafts.push({ at: dec.evaluatedAt, kind: "review", text });
        watchScore = { ...watchScore, unreviewed: 0 };
      }
      // The buy-run line: the telemetry records the next close at
      // which RSI would reach its line whenever RSI is the only
      // missing buy piece. The feed declares it, murmurs once when
      // the price closes in, marks the touch, and withdraws it when
      // the setup breaks — all from the recorded line and decision
      // prices, never a forecast of its own. A BUY ends the story
      // silently: the trade's own entries tell it.
      const line = dec.rsiLinePrice ?? null;
      if (priceLine && line == null) {
        if (dec.action !== "BUY")
          drafts.push({
            at: dec.evaluatedAt,
            kind: "cycle",
            text: "買い走りラインは取り下げ。条件が崩れた",
          });
        priceLine = null;
      } else if (priceLine && line != null) {
        priceLine = { ...priceLine, price: line };
        if (!priceLine.reached && dec.price <= line) {
          priceLine = { ...priceLine, reached: true };
          drafts.push({
            at: dec.evaluatedAt,
            kind: "priceLineReached",
            text: `届いた！${price(line)}タッチ。あとはRSIの反発待ち`,
          });
        } else if (
          !priceLine.reached &&
          !priceLine.murmured &&
          (line / dec.price - 1) * 100 >= PRICE_LINE_MURMUR_PCT
        ) {
          priceLine = { ...priceLine, murmured: true };
          drafts.push({
            at: dec.evaluatedAt,
            kind: "cycle",
            text: `ラインまで あと${((line / dec.price - 1) * 100).toFixed(1)}%。じわじわ来てる`,
          });
        }
      } else if (!priceLine && line != null) {
        priceLine = { price: line, reached: false, murmured: false };
        drafts.push({
          at: dec.evaluatedAt,
          kind: "priceLine",
          text: `宣言するよ。${price(line)}まで下がったらRSIがラインに届く。反発したら買いに走る`,
        });
      }
    }
    priceRising = prevDecisionPrice != null && dec.price > prevDecisionPrice;
    prevDecisionPrice = dec.price;
    lastDecisionAt = dec.evaluatedAt;
    prevTrail = lastTrail;
    lastTrail = decisionTrail(dec);
  }

  // --- connectivity transitions --------------------------------------
  let lastConnectivity = prev.lastConnectivity;
  const connectivity = d.safety?.connectivity ?? null;
  if (connectivity && lastConnectivity && connectivity !== lastConnectivity) {
    if (connectivity === "DEGRADED" && !narratedPaused)
      drafts.push({
        at: now,
        kind: "warning",
        text: "通信が不安定だよ。復旧するまで新規注文は止めてるね",
      });
    else if (connectivity === "RECOVERING")
      drafts.push({
        at: now,
        kind: "status",
        text: `通信の復旧を確認中だよ（正常サイクル${d.safety.healthyCycles}回）`,
      });
    else if (connectivity === "HEALTHY" && !narratedRecovered)
      drafts.push({
        at: now,
        kind: "recovery",
        text: "通信が復旧したよ",
      });
  }
  if (connectivity) lastConnectivity = connectivity;

  // --- status fallback (e.g. a stop with no STOP event) --------------
  let lastStatus = prev.lastStatus;
  if (d.status && lastStatus && d.status !== lastStatus) {
    if (
      (d.status === "STOPPED" || d.status === "ABNORMAL_STOP") &&
      !narratedStop
    )
      drafts.push({
        at: now,
        kind: "stop",
        text: `止まったよ。理由：${stopReasonText(d)}`,
      });
  }
  // Sleep talk: while the bot sleeps (a plain stop — a safety stop
  // is flatlined and never mutters), the character occasionally
  // talks in its sleep, only from recorded facts, never the same
  // mutter twice in a row. Waking resets the cadence, so a later
  // stop starts a fresh sleep.
  if (vitalState === "sleeping") {
    if (sleepingSince == null) sleepingSince = now;
    if (
      now - sleepingSince >= SLEEP_TALK_INTERVAL_MS &&
      (lastSleepTalkAt == null ||
        now - lastSleepTalkAt >= SLEEP_TALK_INTERVAL_MS)
    ) {
      const text = sleepTalkCandidates({
        lastNearMiss,
        lastHitAt,
        entries: prev.entries,
        watchScore,
      }).find((candidate) => candidate !== lastSleepTalkText);
      if (text) {
        drafts.push({ at: now, kind: "sleepTalk", text });
        lastSleepTalkAt = now;
        lastSleepTalkText = text;
      }
    }
  } else {
    sleepingSince = null;
    lastSleepTalkAt = null;
    lastSleepTalkText = null;
  }

  if (d.status) lastStatus = d.status;

  return finish(
    {
      ...prev,
      watch,
      watchScore,
      sessionStartPrice,
      priceHistory,
      alertCooldown,
      lastAlert,
      lastHitAt,
      lastNearMiss,
      priceLine,
      sleepingSince,
      lastSleepTalkAt,
      lastSleepTalkText,
      seen: [...seen],
      pendingCandidateIds: [...pending].slice(-50),
      lastDecisionAt,
      prevDecisionPrice,
      lastTrail,
      prevTrail,
      priceRising,
      lastConnectivity,
      lastStatus,
    },
    drafts,
  );
}

function finish(state: NarrationState, drafts: EntryDraft[]): NarrationState {
  let retiredEventThrough = state.retiredEventThrough;
  let retiredCandidateThrough = state.retiredCandidateThrough;
  for (const key of state.seen.slice(
    0,
    Math.max(0, state.seen.length - MAX_SEEN_KEYS),
  )) {
    const [kind, timestamp] = key.split(":", 2);
    const at = Number(timestamp);
    if (kind === "e")
      retiredEventThrough = Math.max(retiredEventThrough ?? at, at);
    if (kind === "c")
      retiredCandidateThrough = Math.max(retiredCandidateThrough ?? at, at);
  }
  drafts.sort((a, b) => a.at - b.at);
  const entries = [...state.entries];
  let nextEntryId = state.nextEntryId;
  for (const draft of drafts) {
    // Identical wording back-to-back (e.g. two cycles whose evidence
    // did not change) is noise, not narration.
    if (entries.length && entries[entries.length - 1].text === draft.text)
      continue;
    entries.push({
      ...draft,
      id: `narration:${nextEntryId++}`,
    });
  }
  return {
    ...state,
    retiredEventThrough,
    retiredCandidateThrough,
    nextEntryId,
    entries:
      entries.length === state.entries.length &&
      entries.every((entry, i) => entry === state.entries[i])
        ? state.entries
        : entries.slice(-MAX_NARRATION_ENTRIES),
    seen: state.seen.slice(-MAX_SEEN_KEYS),
  };
}

/**
 * The character's pose, derived from the vital state and the feed:
 * - stopped / safety-stopped -> sleep (the narration stops too)
 * - state unknown -> normal (nothing is confirmed, so the agent
 *   neither works at the laptop nor celebrates)
 * - running but degraded / recovering -> laptop (awake and watching
 *   at the desk, but an abnormal-but-awake bot does not celebrate)
 * - the newest entry is a recorded fill -> pointSmile
 * - an upward spike alert fired on the current cycle -> point (a
 *   downward or volume-only alert never celebrates)
 * - a buy signal just fired, or at least two entry conditions are met
 *   (with the price also rising since the previous cycle when only
 *   one is met) -> point （指立て）
 * - otherwise -> laptop (working at the laptop while watching)
 */
export function agentPose(
  state: NarrationState,
  d: OperationsSnapshot,
  vital: BotVital,
  now = Date.now(),
): AgentPose {
  if (vital.state === "sleeping" || vital.state === "flatlined") return "sleep";
  if (vital.state === "unknown") return "normal";
  if (vital.state === "weak") return "laptop";
  if (vital.state !== "alive") return "normal";
  const latest = state.entries.at(-1);
  if (
    latest?.kind === "trade" &&
    now >= latest.at &&
    now - latest.at <= DECISION_FRESH_MS
  )
    return "pointSmile";
  const dec = d.decision;
  if (dec && freshDecision(dec, now)) {
    // Safety states have already returned above, so an upward spike
    // alert on this very cycle may celebrate — and only upward: a
    // plunge or a bare volume spike keeps the laptop pose.
    if (
      state.lastAlert?.direction === "up" &&
      state.lastAlert.at === dec.evaluatedAt
    )
      return "point";
    if (dec.action === "BUY") return "point";
    const met = metEntryConditions(dec);
    if (met >= 2) return "point";
    if (met >= 1 && state.priceRising) return "point";
  }
  // A watch hit told on a recent cycle flashes the smug smile while
  // it is fresh — but only when the decision itself claims no
  // pointing pose: a hit that leaves two conditions met still
  // points at what remains. (The hit line sits a few entries back
  // by now, framed by the cycle's own narration, so the pose keys
  // off the recorded hit time, like the alert linkage above.)
  if (
    state.lastHitAt != null &&
    now >= state.lastHitAt &&
    now - state.lastHitAt <= DECISION_FRESH_MS
  )
    return "pointSmile";
  return "laptop";
}

/** How long a buy celebration lasts (avatar, pill, ticker glow). */
export const BUY_CELEBRATION_MS = 4000;

/**
 * A buy entry only celebrates when it is fresh news: an entry whose
 * recorded time sits far from the moment the feed picked it up is
 * history catching up (a stale display resuming, a backlog
 * draining), not a fill that just happened.
 */
export const CELEBRATION_FRESH_MS = 120_000;

/** A recorded PAPER buy fill (a sell fill is not a celebration). */
export function isBuyTradeEntry(entry: NarrationEntry): boolean {
  return entry.kind === "trade" && entry.side === "BUY";
}

/**
 * The newest buy fill `next` gained over `prev`, or null when the
 * advance added none. Entries are matched by id, so re-rendering
 * the same state — or the session's first advance, whose entries
 * are the recorded history — can never produce a hit: the caller
 * only consults this for advances after the feed initialised.
 */
export function findNewBuyEntry(
  prev: NarrationEntry[],
  next: NarrationEntry[],
): NarrationEntry | null {
  const known = new Set(prev.map((e) => e.id));
  let hit: NarrationEntry | null = null;
  for (const entry of next) {
    if (!known.has(entry.id) && isBuyTradeEntry(entry)) hit = entry;
  }
  return hit;
}

/** Whether the celebration window that opened at `startedAt` is
 * still open at `now`. */
export function buyCelebrationActive(
  startedAt: number | null,
  now: number,
): boolean {
  return (
    startedAt != null &&
    now >= startedAt &&
    now - startedAt < BUY_CELEBRATION_MS
  );
}
