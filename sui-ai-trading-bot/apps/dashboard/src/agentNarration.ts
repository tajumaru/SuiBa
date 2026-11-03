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
 * twice in a row, with a fact-free dream of 基軸通貨 itself as the
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

/* Split into per-area modules under ./narration/ (state, format,
   decision, watch, alerts, advance, pose). This file is only the
   public surface: it re-exports exactly what the former single
   module exported, so import sites are unchanged. */
export type { AgentPose, NarrationKind, NarrationEntry, WatchTarget, WatchScore, SpikeAlertDirection, NarrationState, DecisionTrail, ConditionChipTone, EntryConditionChip, WatchDisplay, WatchScoreDisplay, SpikeAlert } from "./narration/state.ts";
export { MAX_NARRATION_ENTRIES, MAX_CHAT_ENTRIES, trimNarrationEntries, DECISION_FRESH_MS, emptyNarrationState } from "./narration/state.ts";
export { decisionTrail, metEntryConditions, cycleNarrationText, sellLinesOf } from "./narration/decision.ts";
export { WATCH_APPROACH_RATIO, WATCH_WITHDRAW_RATIO, REVIEW_SETTLED_THRESHOLD, REVIEW_BUY_MIN_SETTLED, entryConditionChips, currentConditionChips, currentWatch, currentWatchScore, reviewNarrationTexts } from "./narration/watch.ts";
export { ALERT_PRICE_LOOKBACK, ALERT_PRICE_THRESHOLD, ALERT_VOLUME_THRESHOLD, ALERT_COOLDOWN_CYCLES, spikeAlert } from "./narration/alerts.ts";
export { PRICE_LINE_MURMUR_PCT, SLEEP_TALK_INTERVAL_MS, advanceNarration, btcMutter } from "./narration/advance.ts";
export { agentPose, BUY_CELEBRATION_MS, CELEBRATION_FRESH_MS, isBuyTradeEntry, findNewBuyEntry, buyCelebrationActive } from "./narration/pose.ts";
