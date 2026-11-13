import type {
  EntryDraft,
  MonthlyCounters,
  NarrationEntry,
  NarrationState,
  WatchKindStats,
  WatchScore,
} from "./state.ts";
import { emptyMonthlyCounters, freshDecision } from "./state.ts";
import type { Fill } from "../../../../packages/paper-trading/src/index.ts";
import type {
  BookLevels,
  BtcInfo,
  Candle,
} from "../../../../packages/shared/src/index.ts";
import {
  forecastCallText,
  forecastTouchNearText,
  forecastTouchStateOf,
  forecastTouchText,
  forecastVerdictOf,
  forecastVerdictText,
  TOUCH_NEAR_PCT,
  type ForecastRecord,
} from "../forecastLog.ts";
import { calibText, type CalibEvent } from "../forecastCalib.ts";
import type { DecisionTelemetry } from "../../../worker/src/operations.ts";
import { forecastReasonText } from "./forecast-reason.ts";
import {
  buildMonthlyReport,
  monthKeyOf,
  monthlyReportText,
} from "../monthlyReport.ts";
import { number as fmtNumber, percent as fmtPercent } from "../presentation.ts";
import type { OperationsSnapshot } from "../operationsTypes.ts";
import { operationReason } from "../operationLabels.ts";
import type { VitalState } from "../botVital.ts";
import { cycleNarrationText, decisionTrail, sellLinesOf } from "./decision.ts";
import {
  REVIEW_BUY_MIN_SETTLED,
  REVIEW_SETTLED_THRESHOLD,
  hitStreakText,
  processReach,
  processWatch,
  recordWatchKind,
  reviewNarrationTexts,
} from "./watch.ts";
import { ALERT_COOLDOWN_CYCLES, ALERT_HISTORY_KEEP, spikeAlert } from "./alerts.ts";
import { price } from "./format.ts";
import { advanceBookWalls, type BookWallState } from "./book.ts";

/**
 * The stages of advanceNarration, extracted as functions over a
 * shared working set (AdvanceWork) so each stage — events,
 * candidates, the strategy cycle, connectivity, sleep, weather,
 * book walls, forecasts, the monthly report — can be read on its
 * own. advance.ts orchestrates them in the original order and
 * assembles the next state; the statements inside each stage are
 * the original ones, with the former locals reached via `work`.
 */

/** The buy-run line's one approaching murmur fires when the price
 * closes to within this percent of the line (a negative distance:
 * the line sits below the price until it is touched). */
export const PRICE_LINE_MURMUR_PCT = -1.5;

/** Sleep talk cadence: the first mutter comes this long after the
 * sleep begins, and later mutters keep at least this much space. */
export const SLEEP_TALK_INTERVAL_MS = 15 * 60_000;

/** BTC weather mutters: the character remarks when Bitcoin has
 * moved at least ±1% within the hour (±2% earns a 急に), at
 * most once per direction per two hours, and only off a fresh
 * sample. Pure ambience — the measured verdict was that BTC
 * carries no usable signal for this bot's decisions, so it is
 * never wired to any of them. */
export const BTC_MUTTER_PCT = 1;
export const BTC_MUTTER_RUSH_PCT = 2;
export const BTC_MUTTER_COOLDOWN_MS = 2 * 3600 * 1000;
export const BTC_SAMPLE_FRESH_MS = 3 * 60 * 1000;

/** Forecast declarations: a direction-claiming chart forecast
 * is declared out loud while it is fresh, at most once an hour,
 * and its verdict is told when the horizon closes — or settled
 * quietly when the telling would come more than two hours late.
 * The forecast is the chart's model outlook; the feed declares
 * and judges it on the record, and never feeds it into trading. */
export const FORECAST_CALL_FRESH_MS = 10 * 60_000;
export const FORECAST_CALL_COOLDOWN_MS = 60 * 60_000;
export const FORECAST_VERDICT_FRESH_MS = 2 * 3600 * 1000;

export function btcMutter(
  btc: BtcInfo | null | undefined,
  last: NarrationState["lastBtcMutter"],
  now: number,
): { text: string; direction: "up" | "down" } | null {
  if (!btc || btc.change1hPct == null || !Number.isFinite(btc.change1hPct))
    return null;
  if (now - btc.at > BTC_SAMPLE_FRESH_MS) return null;
  const change = btc.change1hPct;
  if (Math.abs(change) < BTC_MUTTER_PCT) return null;
  const direction: "up" | "down" = change > 0 ? "up" : "down";
  if (
    last &&
    last.direction === direction &&
    now - last.at < BTC_MUTTER_COOLDOWN_MS
  )
    return null;
  const rush = Math.abs(change) >= BTC_MUTTER_RUSH_PCT;
  const head =
    direction === "up"
      ? rush
        ? "BTCが急に上がってきた！"
        : "BTCが上がってきた！"
      : rush
        ? "BTCが急に下がってきた…"
        : "BTCが下がってきた…";
  const pct = `${change > 0 ? "+" : "-"}${Math.abs(change).toFixed(1)}%`;
  const price = `$${Math.round(btc.price).toLocaleString("en-US")}`;
  return { text: `${head} 1時間で${pct}（${price}）`, direction };
}

/**
 * Sleep-talk candidates, in the order the sleeping character would
 * reach for them: the session's near miss first, then a told hit,
 * a recorded buy, a miss that was never a near miss — and always
 * the fact-free dream mutters about 基軸通貨 itself as the fallback.
 * Every factual line is built only from what the state recorded;
 * the caller picks the first candidate that is not a repeat of
 * the previous mutter.
 */
export function sleepTalkCandidates(state: {
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

export function eventKey(e: OperationsSnapshot["events"][number]): string {
  return `e:${e.timestamp}:${e.kind}:${e.code}:${e.apiFailure?.api ?? ""}:${e.apiFailure?.operation ?? ""}:${e.apiFailure?.code ?? ""}`;
}
export function candidateKey(c: OperationsSnapshot["candidates"][number]): string {
  return `c:${c.createdAt}:${c.id}:${c.finalAction}`;
}

export function stopReasonText(d: OperationsSnapshot): string {
  return operationReason(d.stopReason ?? d.safety?.lastStopReason ?? "UNKNOWN");
}

export interface AdvanceWork {
  seen: Set<string>;
  pending: Set<string>;
  drafts: EntryDraft[];
  monthly: Record<string, MonthlyCounters>;
  monthlyFinalised: NarrationState["monthlyFinalised"];
  lastBtcMutter: NarrationState["lastBtcMutter"];
  narratedStop: boolean;
  narratedPaused: boolean;
  narratedRecovered: boolean;
  lastDecisionAt: NarrationState["lastDecisionAt"];
  prevDecisionPrice: NarrationState["prevDecisionPrice"];
  lastTrail: NarrationState["lastTrail"];
  prevTrail: NarrationState["prevTrail"];
  priceRising: NarrationState["priceRising"];
  watch: NarrationState["watch"];
  reach: NarrationState["reach"];
  hitStreak: NarrationState["hitStreak"];
  /** The saved settings are the hard preset: the reach calls
   * and the hit line run their hotter variants. Judged by the
   * caller from presetName, like the header's hard-mode mark. */
  hardMode: boolean;
  watchScore: WatchScore;
  watchKindStats: WatchKindStats;
  sessionStartPrice: NarrationState["sessionStartPrice"];
  priceHistory: NarrationState["priceHistory"];
  alertCooldown: NarrationState["alertCooldown"];
  lastAlert: NarrationState["lastAlert"];
  lastHitAt: NarrationState["lastHitAt"];
  lastNearMiss: NarrationState["lastNearMiss"];
  priceLine: NarrationState["priceLine"];
  sellLines: NarrationState["sellLines"];
  sleepingSince: NarrationState["sleepingSince"];
  lastSleepTalkAt: NarrationState["lastSleepTalkAt"];
  lastSleepTalkText: NarrationState["lastSleepTalkText"];
  lastConnectivity: NarrationState["lastConnectivity"];
  lastStatus: NarrationState["lastStatus"];
  bookWallState: BookWallState;
  forecastDeclared: NarrationState["forecastDeclared"];
  forecastSettled: NarrationState["forecastSettled"];
  forecastTouchSettled: NarrationState["forecastTouchSettled"];
  lastForecastCallAt: NarrationState["lastForecastCallAt"];
  lastCalibScoredAt: NarrationState["lastCalibScoredAt"];
  forecastCalibEventIds: string[];
}

function bumpMonthly(
  work: AdvanceWork,
  at: number,
  fn: (c: MonthlyCounters) => void,
) {
  const key = monthKeyOf(at);
  const base = work.monthly[key] ?? emptyMonthlyCounters();
  const next: MonthlyCounters = {
    ...base,
    stopReasons: { ...base.stopReasons },
  };
  fn(next);
  work.monthly = { ...work.monthly, [key]: next };
}

  // --- operation events, oldest first -------------------------------
export function stageEvents(
  work: AdvanceWork,
  prev: NarrationState,
  d: OperationsSnapshot,
) {
const events = [...(d.events ?? [])].sort(
  (a, b) => a.timestamp - b.timestamp,
);
const apiTimestamps = new Set(
  events.filter((e) => e.kind === "API").map((e) => e.timestamp),
);
for (const e of events) {
  const key = eventKey(e);
  if (work.seen.has(key)) {
    work.seen.delete(key);
    work.seen.add(key);
    continue;
  }
  if (
    prev.retiredEventThrough != null &&
    e.timestamp <= prev.retiredEventThrough
  )
    continue;
  work.seen.add(key);
  if (e.kind === "STOP") {
    work.narratedStop = true;
    if (e.code !== "MANUAL_STOP")
      bumpMonthly(work, e.timestamp, (c) => {
        c.stops += 1;
        c.stopReasons[e.code] = (c.stopReasons[e.code] ?? 0) + 1;
      });
    work.drafts.push({
      at: e.timestamp,
      kind: "stop",
      text:
        e.code === "MANUAL_STOP"
          ? "手動で止められたよ"
          : `止まったよ。理由：${operationReason(e.code)}`,
    });
  } else if (e.kind === "BOOT") {
    work.drafts.push({
      at: e.timestamp,
      kind: "status",
      text: "再起動したよ。開始は手動操作待ちだね",
    });
  } else if (e.kind === "CONTROL") {
    if (e.code === "MANUAL_START") {
      work.drafts.push({
        at: e.timestamp,
        kind: "start",
        text: "PAPER運用を始めたよ",
      });
    } else if (e.code === "PAPER_NETWORK_RECOVERED") {
      work.narratedRecovered = true;
      work.drafts.push({
        at: e.timestamp,
        kind: "recovery",
        text: "通信が戻ったよ。PAPER運用を再開するね",
      });
    } else if (e.code === "PAPER_NETWORK_PAUSED") {
      work.narratedPaused = true;
      work.drafts.push({
        at: e.timestamp,
        kind: "warning",
        text: "通信がおかしいから、注文を一時停止したよ",
      });
    } else if (e.code === "MANUAL_RESET") {
      work.drafts.push({
        at: e.timestamp,
        kind: "status",
        text: "停止状態が解除されたよ",
      });
    }
  } else if (e.kind === "API" && e.apiFailure) {
    work.drafts.push({
      at: e.timestamp,
      kind: "warning",
      text: `${e.apiFailure.api}と通信できなかったよ（${operationReason(e.apiFailure.code)}）`,
    });
  } else if (e.kind === "ANOMALY" && e.fatal) {
    work.drafts.push({
      at: e.timestamp,
      kind: "warning",
      text: `異常を検出したよ：${operationReason(e.code)}`,
    });
  } else if (e.kind === "ERROR" && !apiTimestamps.has(e.timestamp)) {
    // An API event at the same timestamp already told this story.
    work.drafts.push({
      at: e.timestamp,
      kind: "warning",
      text: `処理でエラーが出たよ：${operationReason(e.code)}`,
    });
  }
  // WAIT events are covered by the richer cycle narration below.
}
}

  // --- candidate audits, oldest first --------------------------------
export function stageCandidates(
  work: AdvanceWork,
  prev: NarrationState,
  d: OperationsSnapshot,
) {
const candidates = [...(d.candidates ?? [])].sort(
  (a, b) => a.timestamp - b.timestamp,
);
for (const c of candidates) {
  const key = candidateKey(c);
  const wasPending = work.pending.has(c.id);
  if (c.finalAction !== "PENDING") work.pending.delete(c.id);
  if (work.seen.has(key)) {
    work.seen.delete(key);
    work.seen.add(key);
    continue;
  }
  if (
    !wasPending &&
    prev.retiredCandidateThrough != null &&
    c.createdAt <= prev.retiredCandidateThrough
  )
    continue;
  if (c.finalAction === "PENDING") work.pending.add(c.id);
  work.seen.add(key);
  const qty =
    c.quantityAtomic != null && Number.isFinite(Number(c.quantityAtomic))
      ? `${fmtNumber(Number(c.quantityAtomic) / 1e9, 9)} 基軸通貨`
      : null;
  const quote =
    c.quotePriceUsdc != null
      ? `${fmtNumber(c.quotePriceUsdc, 4)} USDC`
      : null;
  const fill = [qty, quote ? `見積もり価格 ${quote}` : null]
    .filter(Boolean)
    .join("・");
  if (c.finalAction === "BUY" || c.finalAction === "SELL") {
    bumpMonthly(work, c.timestamp, (mc) => {
      if (c.finalAction === "BUY") mc.fillsBuy += 1;
      else mc.fillsSell += 1;
    });
    work.drafts.push({
      at: c.timestamp,
      kind: "trade",
      side: c.finalAction,
      text: `PAPERで${c.finalAction === "BUY" ? "買い" : "売り"}を記録したよ${fill ? `：${fill}` : ""}`,
    });
  } else if (c.finalAction === "WAIT") {
    const reason = c.reasons[0]
      ? operationReason(c.reasons[0])
      : "条件を確認できなかった";
    work.drafts.push({
      at: c.timestamp,
      kind: "rejection",
      text: `${c.side === "BUY" ? "買い" : "売り"}シグナルは出たけど、見送ったよ（${reason}）`,
    });
  } else if (c.finalAction === "SAFE_STOP") {
    work.narratedStop = true;
    const reason = c.reasons[0]
      ? operationReason(c.reasons[0])
      : "安全条件を確認できなかった";
    work.drafts.push({
      at: c.timestamp,
      kind: "stop",
      text: `候補の処理中に安全停止したよ（${reason}）`,
    });
  }
  // PENDING candidates are not final yet: stay silent.
}
}

  // --- strategy cycle, from the decision evidence --------------------
export function stageStrategy(
  work: AdvanceWork,
  d: OperationsSnapshot,
  vitalState: VitalState,
  now: number,
) {
const dec = d.decision;
if (dec && (work.lastDecisionAt == null || dec.evaluatedAt > work.lastDecisionAt)) {
  if (work.sessionStartPrice == null) work.sessionStartPrice = dec.price;
  if (
    (vitalState === "alive" || vitalState === "weak") &&
    freshDecision(dec, now)
  ) {
    // The declared watch advances with the same cycle: its lines
    // frame the cycle's own narration (before / after).
    const outcome = processWatch(work.watch, dec, work.hardMode);
    // The settled watch is the one that was live at the cycle's
    // start: its kind takes the hit or miss in the per-kind record.
    if (outcome.settled != null && work.watch != null)
      work.watchKindStats = recordWatchKind(
        work.watchKindStats,
        work.watch.key,
        outcome.settled,
      );
    work.watch = outcome.watch;
    // The 連チャン streak: a miss settlement breaks it, a TOLD
    // hit grows it and — from the second in a row — the hit line
    // carries the count. Silent settlements move it neither way.
    if (outcome.settled === "miss") work.hitStreak = 0;
    const hitDraft = outcome.before.find(
      (draft) => draft.kind === "watchHit",
    );
    if (hitDraft) {
      work.lastHitAt = dec.evaluatedAt;
      work.hitStreak += 1;
      if (work.hitStreak >= 2)
        hitDraft.text = hitStreakText(hitDraft.text, work.hitStreak);
    }
    if (outcome.nearMiss) work.lastNearMiss = outcome.nearMiss;
    work.drafts.push(...outcome.before);
    work.drafts.push({
      at: dec.evaluatedAt,
      kind: "cycle",
      text: cycleNarrationText(dec, work.lastTrail),
    });
    // A sudden market move breaks in right after the cycle's own
    // line: it is market news alongside the decision, never a
    // replacement for it. The price joins the look-back history
    // either way; while the cooldown from the last alert runs,
    // this cycle stays silent and counts the cooldown down.
    if (work.alertCooldown > 0) {
      work.alertCooldown -= 1;
    } else {
      const alert = spikeAlert(work.priceHistory, dec);
      if (alert) {
        work.drafts.push({
          at: dec.evaluatedAt,
          kind: "alert",
          text: alert.text,
        });
        work.lastAlert = { at: dec.evaluatedAt, direction: alert.direction };
        work.alertCooldown = ALERT_COOLDOWN_CYCLES;
      }
    }
    if (Number.isFinite(dec.price) && dec.price > 0)
      work.priceHistory = [...work.priceHistory, dec.price].slice(-ALERT_HISTORY_KEEP);
    work.drafts.push(...outcome.after);
    // The reach escalation rides on the same cycle: the watch
    // has just been advanced, so its approach judgement for the
    // one missing condition is this cycle's own.
    const reachOutcome = processReach(
      work.reach,
      work.watch,
      dec,
      work.hardMode,
    );
    work.reach = reachOutcome.reach;
    work.drafts.push(...reachOutcome.drafts);
    // Score the cycle's declaration / settlement, then — only at
    // a milestone — pause for a short look-back over the record.
    const settled = outcome.settled != null;
    work.watchScore = {
      declared: work.watchScore.declared + (outcome.created ? 1 : 0),
      hits: work.watchScore.hits + (outcome.settled === "hit" ? 1 : 0),
      misses: work.watchScore.misses + (outcome.settled === "miss" ? 1 : 0),
      unreviewed: work.watchScore.unreviewed + (settled ? 1 : 0),
    };
    if (outcome.created || settled || outcome.nearMiss)
      bumpMonthly(work, dec.evaluatedAt, (mc) => {
        mc.declared += outcome.created ? 1 : 0;
        mc.hits += outcome.settled === "hit" ? 1 : 0;
        mc.misses += outcome.settled === "miss" ? 1 : 0;
        mc.nearMisses += outcome.nearMiss ? 1 : 0;
      });
    const buyMilestone = dec.action === "BUY";
    if (
      work.watchScore.unreviewed >= REVIEW_SETTLED_THRESHOLD ||
      (buyMilestone && work.watchScore.unreviewed >= REVIEW_BUY_MIN_SETTLED)
    ) {
      for (const text of reviewNarrationTexts(
        work.watchScore,
        work.sessionStartPrice,
        dec.price,
        buyMilestone,
      ))
        work.drafts.push({ at: dec.evaluatedAt, kind: "review", text });
      work.watchScore = { ...work.watchScore, unreviewed: 0 };
    }
    // The buy-run line: the telemetry records the next close at
    // which RSI would reach its line whenever RSI is the only
    // missing buy piece. The feed declares it, murmurs once when
    // the price closes in, marks the touch, and withdraws it when
    // the setup breaks — all from the recorded line and decision
    // prices, never a forecast of its own. A BUY ends the story
    // silently: the trade's own entries tell it.
    const line = dec.rsiLinePrice ?? null;
    if (work.priceLine && line == null) {
      if (dec.action !== "BUY")
        work.drafts.push({
          at: dec.evaluatedAt,
          kind: "cycle",
          text: "買い走りラインは取り下げ。条件が崩れた",
        });
      work.priceLine = null;
    } else if (work.priceLine && line != null) {
      work.priceLine = { ...work.priceLine, price: line };
      if (!work.priceLine.reached && dec.price <= line) {
        work.priceLine = { ...work.priceLine, reached: true };
        work.drafts.push({
          at: dec.evaluatedAt,
          kind: "priceLineReached",
          text: `届いた！${price(line)}タッチ。あとはRSIの反発待ち`,
        });
      } else if (
        !work.priceLine.reached &&
        !work.priceLine.murmured &&
        (line / dec.price - 1) * 100 >= PRICE_LINE_MURMUR_PCT
      ) {
        work.priceLine = { ...work.priceLine, murmured: true };
        work.drafts.push({
          at: dec.evaluatedAt,
          kind: "cycle",
          text: `ラインまで あと${((line / dec.price - 1) * 100).toFixed(1)}%。じわじわ来てる`,
        });
      }
    } else if (!work.priceLine && line != null) {
      work.priceLine = { price: line, reached: false, murmured: false };
      work.drafts.push({
        at: dec.evaluatedAt,
        kind: "priceLine",
        text: `宣言するよ。${price(line)}まで下がったらRSIがラインに届く。反発したら買いに走る`,
      });
    }
    // The sell lines: while a position is open, its take-profit
    // and stop-loss prices are fixed by the recorded entry price
    // and percentages. The feed declares the pair once per
    // position; the ticker counts down to the nearer one. The
    // position closing ends the story silently — the sell's own
    // trade entries tell it — and changed percentages simply move
    // the lines without another word.
    const lines = sellLinesOf(dec);
    if (lines && !work.sellLines) {
      work.sellLines = lines;
      work.drafts.push({
        at: dec.evaluatedAt,
        kind: "sellLine",
        text: `売りラインを引くよ。利確は${price(lines.tp)}、損切りは${price(lines.sl)}。どっちかに届いたら売る`,
      });
    } else if (lines && work.sellLines) {
      work.sellLines = lines;
    } else if (!lines && work.sellLines) {
      work.sellLines = null;
    }
  }
  work.priceRising = work.prevDecisionPrice != null && dec.price > work.prevDecisionPrice;
  work.prevDecisionPrice = dec.price;
  work.lastDecisionAt = dec.evaluatedAt;
  work.prevTrail = work.lastTrail;
  work.lastTrail = decisionTrail(dec);
}
}

  // --- connectivity transitions --------------------------------------
export function stageConnectivity(
  work: AdvanceWork,
  d: OperationsSnapshot,
  now: number,
) {
const connectivity = d.safety?.connectivity ?? null;
if (connectivity && work.lastConnectivity && connectivity !== work.lastConnectivity) {
  if (connectivity === "DEGRADED" && !work.narratedPaused)
    work.drafts.push({
      at: now,
      kind: "warning",
      text: "通信が不安定だよ。復旧するまで新規注文は止めてるね",
    });
  else if (connectivity === "RECOVERING")
    work.drafts.push({
      at: now,
      kind: "status",
      text: `通信の復旧を確認中だよ（正常サイクル${d.safety.healthyCycles}回）`,
    });
  else if (connectivity === "HEALTHY" && !work.narratedRecovered)
    work.drafts.push({
      at: now,
      kind: "recovery",
      text: "通信が復旧したよ",
    });
}
if (connectivity) work.lastConnectivity = connectivity;
}

  // --- status fallback (e.g. a stop with no STOP event) --------------
export function stageStatusAndSleep(
  work: AdvanceWork,
  prev: NarrationState,
  d: OperationsSnapshot,
  vitalState: VitalState,
  now: number,
) {
if (d.status && work.lastStatus && d.status !== work.lastStatus) {
  if (
    (d.status === "STOPPED" || d.status === "ABNORMAL_STOP") &&
    !work.narratedStop
  )
    work.drafts.push({
      at: now,
      kind: "stop",
      text:
        d.status === "STOPPED" && d.safety?.resumePending
          ? "通信のため注文を止めたよ。自動復旧を確認してるね"
          : `止まったよ。理由：${stopReasonText(d)}`,
    });
}
// Sleep talk: while the bot sleeps (a plain stop — a safety stop
// is flatlined and never mutters), the character occasionally
// talks in its sleep, only from recorded facts, never the same
// mutter twice in a row. Waking resets the cadence, so a later
// stop starts a fresh sleep.
if (vitalState === "sleeping") {
  if (work.sleepingSince == null) work.sleepingSince = now;
  if (
    now - work.sleepingSince >= SLEEP_TALK_INTERVAL_MS &&
    (work.lastSleepTalkAt == null ||
      now - work.lastSleepTalkAt >= SLEEP_TALK_INTERVAL_MS)
  ) {
    const text = sleepTalkCandidates({
      lastNearMiss: work.lastNearMiss,
      lastHitAt: work.lastHitAt,
        entries: prev.entries,
        watchScore: work.watchScore,
    }).find((candidate) => candidate !== work.lastSleepTalkText);
    if (text) {
      work.drafts.push({ at: now, kind: "sleepTalk", text });
      work.lastSleepTalkAt = now;
      work.lastSleepTalkText = text;
    }
  }
} else {
  work.sleepingSince = null;
  work.lastSleepTalkAt = null;
  work.lastSleepTalkText = null;
}

if (d.status) work.lastStatus = d.status;
}

  // BTC weather: an ambient mutter when Bitcoin has moved an
  // hour's worth. The character noticing the market's weather
  // — never an input to any decision.
export function stageBtc(
  work: AdvanceWork,
  btc: BtcInfo | null | undefined,
  now: number,
) {
const mutter = btcMutter(btc, work.lastBtcMutter, now);
if (mutter) {
  work.drafts.push({ at: now, kind: "btc", text: mutter.text });
  work.lastBtcMutter = { at: now, direction: mutter.direction };
}
}

  // Order-book walls: a wall appears, vanishes, or is
  // breached — the book's events, told like the BTC weather.
  // Display-only; the first snapshot is adopted silently.
export function stageBook(
  work: AdvanceWork,
  book: BookLevels | null | undefined,
  pairLabel: string,
  now: number,
) {
if (book) {
  const advanced = advanceBookWalls(work.bookWallState, book, pairLabel, now);
  work.bookWallState = advanced.state;
  for (const text of advanced.texts)
    work.drafts.push({ at: now, kind: "bookWall", text });
}
}

  // Forecast declarations and verdicts: the chart's outlook,
  // spoken as a promise and settled on the record. Verdicts of
  // promises already made are settled first; then the newest
  // fresh claim may be declared, at most once an hour.
export function stageForecasts(
  work: AdvanceWork,
  forecasts:
    | { records: readonly ForecastRecord[]; candles: readonly Candle[] }
    | null
    | undefined,
  dec: DecisionTelemetry | null | undefined,
  now: number,
) {
if (forecasts) {
  const pruneBefore = now - 3 * 24 * 3600 * 1000;
  const pruned = <T,>(m: Record<string, T>): Record<string, T> =>
    Object.fromEntries(
      Object.entries(m).filter(([k]) => Number(k) * 1000 >= pruneBefore),
    );
  work.forecastDeclared = pruned(work.forecastDeclared);
  work.forecastSettled = pruned(work.forecastSettled);
  work.forecastTouchSettled = pruned(work.forecastTouchSettled);
  // Touch settlements first: a line can be reached long
  // before its forecast's horizon closes, and that moment
  // is the story. Only declared forecasts speak, like the
  // verdicts; a near miss (within TOUCH_NEAR_PCT) is told,
  // a distant one closes quietly.
  for (const rec of forecasts.records) {
    const key = String(rec.origin);
    if (work.forecastDeclared[key] == null || work.forecastTouchSettled[key])
      continue;
    const t = forecastTouchStateOf(rec, forecasts.candles);
    if (!t || t.phase === "pending") continue;
    work.forecastTouchSettled = { ...work.forecastTouchSettled, [key]: true };
    if (now - t.endsAt > FORECAST_VERDICT_FRESH_MS) continue;
    if (t.phase === "touched") {
      work.drafts.push({
        at: now,
        kind: "forecastTouch",
        text: forecastTouchText(t),
      });
      work.lastHitAt = now;
    } else if (t.closestAwayPct <= TOUCH_NEAR_PCT) {
      work.drafts.push({
        at: now,
        kind: "forecastTouchNear",
        text: forecastTouchNearText(t),
      });
    }
  }
  for (const rec of forecasts.records) {
    const key = String(rec.origin);
    if (work.forecastDeclared[key] == null || work.forecastSettled[key]) continue;
    const verdict = forecastVerdictOf(rec, forecasts.candles);
    if (!verdict) continue;
    work.forecastSettled = { ...work.forecastSettled, [key]: true };
    if (now - verdict.completedAt > FORECAST_VERDICT_FRESH_MS) continue;
    work.drafts.push({
      at: now,
      kind: verdict.hit ? "forecastHit" : "forecastMiss",
      text: forecastVerdictText(verdict),
      forecastOrigin: rec.origin,
    });
    if (verdict.hit) work.lastHitAt = now;
  }
  for (let i = forecasts.records.length - 1; i >= 0; i--) {
    const rec = forecasts.records[i];
    if (rec.dir === "flat") continue;
    const key = String(rec.origin);
    if (work.forecastDeclared[key] != null) continue;
    const originMs = rec.origin * 1000;
    if (now - originMs > FORECAST_CALL_FRESH_MS || originMs > now + 60_000)
      continue;
    if (
      work.lastForecastCallAt != null &&
      now - work.lastForecastCallAt < FORECAST_CALL_COOLDOWN_MS
    )
      break;
    work.drafts.push({
      at: now,
      kind: "forecastCall",
      text: forecastCallText(rec, forecastReasonText(rec, dec, now)),
      forecastOrigin: rec.origin,
    });
    work.forecastDeclared = { ...work.forecastDeclared, [key]: now };
    work.lastForecastCallAt = now;
    break;
  }
}
}

/** How fresh a calibration change must be to be told; an older
 * one is adopted silently (the feed was closed when it happened). */
export const CALIB_TELL_FRESH_MS = 30 * 60 * 1000;

// Cone calibration: when the forecast cone's width has learned
// from its scored record, say so once — the numbers it stands
// on, nothing more. Dedupe is by the scored count the change
// was evaluated at, so re-renders never repeat it.
export function stageCalibration(
  work: AdvanceWork,
  calib: CalibEvent | null | undefined,
  now: number,
) {
  if (calib?.id) {
    if (work.forecastCalibEventIds.includes(calib.id)) return;
    work.forecastCalibEventIds = [...work.forecastCalibEventIds, calib.id];
    work.drafts.push({ id: calib.id, at: calib.at, kind: "forecastCalib", text: calibText(calib) });
    return;
  }
  if (!calib || calib.scored <= work.lastCalibScoredAt) return;
  work.lastCalibScoredAt = calib.scored;
  if (now - calib.at > CALIB_TELL_FRESH_MS) return;
  work.drafts.push({ at: now, kind: "forecastCalib", text: calibText(calib) });
}

  // Monthly report: a finished month with tallies is posted to
  // the feed exactly once, oldest first, once the fills that
  // price it are at hand.
export function stageMonthly(
  work: AdvanceWork,
  fills: readonly Fill[] | undefined,
  now: number,
) {
if (fills) {
  const currentMonth = monthKeyOf(now);
  const pendingMonths = Object.keys(work.monthly)
    .filter(
      (k) =>
        k < currentMonth &&
        (work.monthlyFinalised == null || k > work.monthlyFinalised),
    )
    .sort();
  for (const key of pendingMonths) {
    const report = buildMonthlyReport({
      monthKey: key,
      fills,
      fillsWindowCapped: fills.length >= 200,
      counters: work.monthly[key],
    });
    work.drafts.push({
      at: now,
      kind: "monthlyReport",
      text: monthlyReportText(report),
    });
    work.monthlyFinalised = key;
  }
}
}

