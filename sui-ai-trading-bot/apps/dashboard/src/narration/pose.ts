import type { AgentPose, NarrationEntry, NarrationState } from "./state.ts";
import type { OperationsSnapshot } from "../operationsTypes.ts";
import type { BotVital } from "../botVital.ts";
import { DECISION_FRESH_MS, freshDecision } from "./state.ts";
import { metEntryConditions } from "./decision.ts";

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
  const fresh = dec != null && freshDecision(dec, now);
  if (fresh) {
    // Safety states have already returned above, so an upward spike
    // alert on this very cycle may celebrate — and only upward: a
    // plunge or a bare volume spike keeps the laptop pose.
    if (
      state.lastAlert?.direction === "up" &&
      state.lastAlert.at === dec.evaluatedAt
    )
      return "point";
  }
  // A standing buy-run line turns the character blue — the roaring
  // crowd artwork — for as long as the line stands. The line only
  // stands while RSI is the last missing piece, which means the
  // other two conditions are met by construction: the met-count
  // pointing below would claim every fresh cycle and the blue
  // would never show. So the line ranks above the persistent
  // pointing (the blue artwork points too), and below only a
  // recorded fill and an upward spike.
  if (state.priceLine != null) return "buyLine";
  if (fresh) {
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
