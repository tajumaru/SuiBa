import type { EntryDraft, MonthlyCounters, NarrationEntry, NarrationState, WatchScore, WatchTarget } from "./state.ts";
import { emptyMonthlyCounters } from "./state.ts";
import type { Fill } from "../../../../packages/paper-trading/src/index.ts";
import type { BtcInfo } from "../../../../packages/shared/src/index.ts";
import {
  buildMonthlyReport,
  monthKeyOf,
  monthlyReportText,
} from "../monthlyReport.ts";
import { number as fmtNumber, percent as fmtPercent } from "../presentation.ts";
import type { OperationsSnapshot } from "../operationsTypes.ts";
import { operationReason } from "../operationLabels.ts";
import type { VitalState } from "../botVital.ts";
import { MAX_SEEN_KEYS, freshDecision, trimNarrationEntries } from "./state.ts";
import { cycleNarrationText, decisionTrail, sellLinesOf } from "./decision.ts";
import { REVIEW_BUY_MIN_SETTLED, REVIEW_SETTLED_THRESHOLD, chooseWatchTarget, makeWatch, processWatch, reviewNarrationTexts, watchEligible } from "./watch.ts";
import { ALERT_COOLDOWN_CYCLES, ALERT_HISTORY_KEEP, spikeAlert } from "./alerts.ts";
import { price } from "./format.ts";
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
): NarrationState {
  const seen = new Set(prev.seen);
  const pending = new Set(prev.pendingCandidateIds);
  const drafts: EntryDraft[] = [];
  // Monthly tallies for the report: counted here, at the same
  // moments the facts themselves are narrated, never recounted.
  let monthly = prev.monthly;
  let monthlyFinalised = prev.monthlyFinalised;
  let lastBtcMutter = prev.lastBtcMutter;
  const bumpMonthly = (at: number, fn: (c: MonthlyCounters) => void) => {
    const key = monthKeyOf(at);
    const base = monthly[key] ?? emptyMonthlyCounters();
    const next: MonthlyCounters = {
      ...base,
      stopReasons: { ...base.stopReasons },
    };
    fn(next);
    monthly = { ...monthly, [key]: next };
  };
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
      if (e.code !== "MANUAL_STOP")
        bumpMonthly(e.timestamp, (c) => {
          c.stops += 1;
          c.stopReasons[e.code] = (c.stopReasons[e.code] ?? 0) + 1;
        });
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
      bumpMonthly(c.timestamp, (mc) => {
        if (c.finalAction === "BUY") mc.fillsBuy += 1;
        else mc.fillsSell += 1;
      });
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
  let sellLines = prev.sellLines;
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
      if (outcome.created || settled || outcome.nearMiss)
        bumpMonthly(dec.evaluatedAt, (mc) => {
          mc.declared += outcome.created ? 1 : 0;
          mc.hits += outcome.settled === "hit" ? 1 : 0;
          mc.misses += outcome.settled === "miss" ? 1 : 0;
          mc.nearMisses += outcome.nearMiss ? 1 : 0;
        });
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
      // The sell lines: while a position is open, its take-profit
      // and stop-loss prices are fixed by the recorded entry price
      // and percentages. The feed declares the pair once per
      // position; the ticker counts down to the nearer one. The
      // position closing ends the story silently — the sell's own
      // trade entries tell it — and changed percentages simply move
      // the lines without another word.
      const lines = sellLinesOf(dec);
      if (lines && !sellLines) {
        sellLines = lines;
        drafts.push({
          at: dec.evaluatedAt,
          kind: "sellLine",
          text: `売りラインを引くよ。利確は${price(lines.tp)}、損切りは${price(lines.sl)}。どっちかに届いたら売る`,
        });
      } else if (lines && sellLines) {
        sellLines = lines;
      } else if (!lines && sellLines) {
        sellLines = null;
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

  // BTC weather: an ambient mutter when Bitcoin has moved an
  // hour's worth. The character noticing the market's weather
  // — never an input to any decision.
  const mutter = btcMutter(btc, lastBtcMutter, now);
  if (mutter) {
    drafts.push({ at: now, kind: "btc", text: mutter.text });
    lastBtcMutter = { at: now, direction: mutter.direction };
  }

  // Monthly report: a finished month with tallies is posted to
  // the feed exactly once, oldest first, once the fills that
  // price it are at hand.
  if (fills) {
    const currentMonth = monthKeyOf(now);
    const pendingMonths = Object.keys(monthly)
      .filter(
        (k) =>
          k < currentMonth &&
          (monthlyFinalised == null || k > monthlyFinalised),
      )
      .sort();
    for (const key of pendingMonths) {
      const report = buildMonthlyReport({
        monthKey: key,
        fills,
        fillsWindowCapped: fills.length >= 200,
        counters: monthly[key],
      });
      drafts.push({
        at: now,
        kind: "monthlyReport",
        text: monthlyReportText(report),
      });
      monthlyFinalised = key;
    }
  }

  return finish(
    {
      ...prev,
      watch,
      watchScore,
      monthly,
      monthlyFinalised,
      lastBtcMutter,
      sessionStartPrice,
      priceHistory,
      alertCooldown,
      lastAlert,
      lastHitAt,
      lastNearMiss,
      priceLine,
      sellLines,
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
