import type {
  EntryDraft,
  NarrationState,
  WatchTarget,
} from "./state.ts";
import { MAX_SEEN_KEYS, freshDecision, trimNarrationEntries } from "./state.ts";
import type { Fill } from "../../../../packages/paper-trading/src/index.ts";
import type {
  BookLevels,
  BtcInfo,
  Candle,
} from "../../../../packages/shared/src/index.ts";
import {
  forecastTouchStateOf,
  forecastVerdictOf,
  type ForecastRecord,
} from "../forecastLog.ts";
import type { OperationsSnapshot } from "../operationsTypes.ts";
import type { VitalState } from "../botVital.ts";
import { cycleNarrationText, decisionTrail, sellLinesOf } from "./decision.ts";
import { chooseWatchTarget, makeWatch, watchEligible } from "./watch.ts";
import {
  PRICE_LINE_MURMUR_PCT,
  candidateKey,
  eventKey,
  stageBook,
  stageBtc,
  stageCandidates,
  stageConnectivity,
  stageEvents,
  stageForecasts,
  stageMonthly,
  stageStatusAndSleep,
  stageStrategy,
  stopReasonText,
  type AdvanceWork,
} from "./advance-stages.ts";
export {
  FORECAST_CALL_COOLDOWN_MS,
  FORECAST_CALL_FRESH_MS,
  FORECAST_VERDICT_FRESH_MS,
  PRICE_LINE_MURMUR_PCT,
  SLEEP_TALK_INTERVAL_MS,
  btcMutter,
  candidateKey,
  eventKey,
  sleepTalkCandidates,
  stopReasonText,
} from "./advance-stages.ts";

export function initialEntry(
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
  if (
    vitalState !== "unknown" &&
    ["DEGRADED", "RECOVERING"].includes(d.safety?.connectivity)
  )
    return {
      at: now,
      kind: "warning",
      text: d.safety.resumePending
        ? "注文を止めて、自動復旧を確認してるよ"
        : "通信を確認中だよ。安全確認後も手動開始が必要だよ",
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
  /** The engine's newest fills (snapshot window), used only to
   * build a finished month's report. Without them the monthly
   * finalisation waits — counters still accumulate. */
  fills?: readonly Fill[],
  /** The latest BTC weather sample (display-only), for the
   * character's ambient mutters. */
  btc?: BtcInfo | null,
  /** The chart's recorded forecasts with the candles that judge
   * them (display-only), for declarations and verdicts. */
  forecasts?: {
    records: readonly ForecastRecord[];
    candles: readonly Candle[];
  } | null,
  /** The latest top-of-book levels (display-only), for the
   * order-book wall watch. */
  book?: BookLevels | null,
  /** The pair's base symbol (e.g. "SUI"), for book entry
   * quantities. */
  pairLabel = "SUI",
): NarrationState {
  const seen = new Set(prev.seen);
  const pending = new Set(prev.pendingCandidateIds);
  const drafts: EntryDraft[] = [];
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
    // Existing forecasts are adopted silently on first load,
    // like the first watch and the buy-run line: their stories
    // are already under way. Only forecasts recorded from here
    // on are declared out loud, and adopted verdicts settle
    // quietly — no backlog of old answers on a fresh feed.
    const adoptedDeclared: Record<string, number> = {};
    const adoptedSettled: Record<string, boolean> = {};
    const adoptedTouchSettled: Record<string, boolean> = {};
    if (forecasts) {
      for (const rec of forecasts.records) {
        if (rec.dir === "flat") continue;
        adoptedDeclared[String(rec.origin)] = now;
        if (forecastVerdictOf(rec, forecasts.candles))
          adoptedSettled[String(rec.origin)] = true;
        const t = forecastTouchStateOf(rec, forecasts.candles);
        if (t && t.phase !== "pending")
          adoptedTouchSettled[String(rec.origin)] = true;
      }
    }
    return finish(
      {
        ...prev,
        forecastDeclared: adoptedDeclared,
        forecastSettled: adoptedSettled,
        forecastTouchSettled: adoptedTouchSettled,
        watch: firstWatch,
        watchScore: firstScore,
        priceLine: firstPriceLine,
        // A position already open when the feed starts has its sell
        // lines adopted silently, like the buy-run line above.
        sellLines: firstDec ? sellLinesOf(firstDec) : null,
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

  const work: AdvanceWork = {
    seen,
    pending,
    drafts,
    monthly: prev.monthly,
    monthlyFinalised: prev.monthlyFinalised,
    lastBtcMutter: prev.lastBtcMutter,
    narratedStop: false,
    narratedPaused: false,
    narratedRecovered: false,
    lastDecisionAt: prev.lastDecisionAt,
    prevDecisionPrice: prev.prevDecisionPrice,
    lastTrail: prev.lastTrail,
    prevTrail: prev.prevTrail,
    priceRising: prev.priceRising,
    watch: prev.watch,
    watchScore: prev.watchScore,
    sessionStartPrice: prev.sessionStartPrice,
    priceHistory: prev.priceHistory,
    alertCooldown: prev.alertCooldown,
    lastAlert: prev.lastAlert,
    lastHitAt: prev.lastHitAt,
    lastNearMiss: prev.lastNearMiss,
    priceLine: prev.priceLine,
    sellLines: prev.sellLines,
    sleepingSince: prev.sleepingSince,
    lastSleepTalkAt: prev.lastSleepTalkAt,
    lastSleepTalkText: prev.lastSleepTalkText,
    lastConnectivity: prev.lastConnectivity,
    lastStatus: prev.lastStatus,
    bookWallState: {
      walls: prev.bookWalls,
      bookAt: prev.bookAt,
      adopted: prev.bookAdopted,
      lastEntryAt: prev.lastBookEntryAt,
      cooldowns: prev.bookWallCooldowns,
    },
    forecastDeclared: prev.forecastDeclared,
    forecastSettled: prev.forecastSettled,
    forecastTouchSettled: prev.forecastTouchSettled,
    lastForecastCallAt: prev.lastForecastCallAt,
  };
  stageEvents(work, prev, d);
  stageCandidates(work, prev, d);
  stageStrategy(work, d, vitalState, now);
  stageConnectivity(work, d, now);
  stageStatusAndSleep(work, prev, d, vitalState, now);
  stageBtc(work, btc, now);
  stageBook(work, book, pairLabel, now);
  stageForecasts(work, forecasts, now);
  stageMonthly(work, fills, now);

  return finish(
    {
      ...prev,
      watch: work.watch,
      watchScore: work.watchScore,
      monthly: work.monthly,
      monthlyFinalised: work.monthlyFinalised,
      lastBtcMutter: work.lastBtcMutter,
      bookWalls: work.bookWallState.walls,
      bookAt: work.bookWallState.bookAt,
      bookAdopted: work.bookWallState.adopted,
      lastBookEntryAt: work.bookWallState.lastEntryAt,
      bookWallCooldowns: work.bookWallState.cooldowns,
      forecastDeclared: work.forecastDeclared,
      forecastSettled: work.forecastSettled,
      forecastTouchSettled: work.forecastTouchSettled,
      lastForecastCallAt: work.lastForecastCallAt,
      sessionStartPrice: work.sessionStartPrice,
      priceHistory: work.priceHistory,
      alertCooldown: work.alertCooldown,
      lastAlert: work.lastAlert,
      lastHitAt: work.lastHitAt,
      lastNearMiss: work.lastNearMiss,
      priceLine: work.priceLine,
      sellLines: work.sellLines,
      sleepingSince: work.sleepingSince,
      lastSleepTalkAt: work.lastSleepTalkAt,
      lastSleepTalkText: work.lastSleepTalkText,
      seen: [...work.seen],
      pendingCandidateIds: [...work.pending].slice(-50),
      lastDecisionAt: work.lastDecisionAt,
      prevDecisionPrice: work.prevDecisionPrice,
      lastTrail: work.lastTrail,
      prevTrail: work.prevTrail,
      priceRising: work.priceRising,
      lastConnectivity: work.lastConnectivity,
      lastStatus: work.lastStatus,
    },
    work.drafts,
  );
}

export function finish(state: NarrationState, drafts: EntryDraft[]): NarrationState {
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
        : trimNarrationEntries(entries),
    seen: state.seen.slice(-MAX_SEEN_KEYS),
  };
}
