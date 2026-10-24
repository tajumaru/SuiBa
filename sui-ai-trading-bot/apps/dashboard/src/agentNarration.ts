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
 * All functions here are pure: the component keeps a NarrationState,
 * feeds each new snapshot through `advanceNarration`, and renders the
 * accumulated entries. `agentPose` derives the character's pose from
 * the same state, so pose and text can never disagree.
 */
export type AgentPose = "normal" | "point" | "pointSmile" | "sleep";

export type NarrationKind =
  | "cycle" // a strategy analysis cycle (WAIT / signal / position watch)
  | "trade" // a PAPER fill was recorded
  | "rejection" // a signal fired but a gate turned it down
  | "warning" // API failure, anomaly, degraded connectivity
  | "stop" // the bot stopped (manual or safety)
  | "start" // the bot started
  | "recovery" // connectivity recovered / run resumed
  | "status"; // feed-initialised status line

export interface NarrationEntry {
  id: string;
  at: number;
  kind: NarrationKind;
  text: string;
}

export interface NarrationState {
  entries: NarrationEntry[];
  nextEntryId: number;
  priceRising: boolean;
  /** Dedupe keys for operation events (`e:...`) and candidates (`c:...`). */
  seen: string[];
  /** evaluatedAt of the newest decision already accounted for. */
  lastDecisionAt: number | null;
  /** Price of the previous narrated cycle, for grounded price-move text. */
  prevDecisionPrice: number | null;
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
    seen: [],
    lastDecisionAt: null,
    prevDecisionPrice: null,
    lastConnectivity: null,
    lastStatus: null,
    initialized: false,
  };
}

const price = (v: number) => `${fmtNumber(v, 4)} USDC`;
const signedPct = (ratio: number) =>
  `${ratio > 0 ? "+" : ""}${fmtPercent(ratio)}`;

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

function furthestUnmetSentence(dec: DecisionTelemetry): string | null {
  const unmet = entryConditions(dec).filter((c) => !c.met);
  if (!unmet.length) return null;
  const furthest = unmet.reduce((a, b) =>
    unmetDistance(dec, b.key) > unmetDistance(dec, a.key) ? b : a,
  );
  if (furthest.key === "emaUp")
    return `EMA20（${fmtNumber(dec.ema20, 4)}）がEMA50（${fmtNumber(dec.ema50, 4)}）を上回るのを待っています。`;
  if (furthest.key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? `RSIは${fmtNumber(dec.rsi, 1)}で売られすぎライン（${fmtNumber(dec.oversold, 1)}）の下にあります。反発の起点待ちです。`
      : `RSIは${fmtNumber(dec.rsi, 1)}。売られすぎ（${fmtNumber(dec.oversold, 1)}以下）からの回復サインはまだありません。`;
  return `MACDヒストグラムの改善待ちです（前回 ${fmtNumber(dec.previousHistogram, 4)} → 現在 ${fmtNumber(dec.histogram, 4)}）。`;
}

/** Narration text for one analysed cycle, from its decision evidence. */
export function cycleNarrationText(
  dec: DecisionTelemetry,
  prevPrice: number | null,
): string {
  if (dec.action === "BUY")
    return `買いシグナルが成立しました（買い条件 3/3）。価格は${price(dec.price)}です。`;
  if (dec.action === "SELL") {
    const entry =
      dec.entryPrice != null && dec.entryPrice > 0
        ? `取得価格${price(dec.entryPrice)}に対して現在${price(dec.price)}（${signedPct(dec.price / dec.entryPrice - 1)}）`
        : `価格は${price(dec.price)}`;
    switch (dec.sellPurpose) {
      case "TAKE_PROFIT":
        return `利確条件に触れました。${entry}です。`;
      case "STOP_LOSS":
        return `損切り条件に触れました。${entry}です。`;
      case "STRATEGY_EXIT":
        return `売りシグナルが成立しました（EMA下降・RSI反落・MACD悪化）。価格は${price(dec.price)}です。`;
      case "RISK_REDUCTION":
      case "EMERGENCY_EXIT":
        return `リスク低減のための売り判定になりました。価格は${price(dec.price)}です。`;
      default:
        return `売り判定になりました。価格は${price(dec.price)}です。`;
    }
  }
  if (dec.selectedRule === "VOLUME_REJECT")
    return `出来高の異常を検出したため見送りました（出来高の変化 ${fmtPercent(dec.volumeChange)}、価格 ${price(dec.price)}）。`;
  if (dec.conditions.hasPosition && dec.entryPrice != null) {
    const pct =
      dec.entryPrice > 0 ? signedPct(dec.price / dec.entryPrice - 1) : "±0%";
    return `保有中です。取得価格${price(dec.entryPrice)}に対して現在${price(dec.price)}（${pct}）。利確ライン（+${fmtPercent(dec.takeProfitPct)}）と損切りライン（-${fmtPercent(dec.stopLossPct)}）を見守っています。`;
  }
  const met = metEntryConditions(dec);
  const parts: string[] = [];
  if (prevPrice != null && prevPrice > 0) {
    const change = dec.price / prevPrice - 1;
    if (Math.abs(change) >= 0.003)
      parts.push(
        `価格は${price(dec.price)}（前回の判定から${signedPct(change)}）。`,
      );
  }
  parts.push(
    met === 0
      ? "様子見です。買い条件は0/3で、まだ何もそろっていません。"
      : `買い条件が${met}/3そろってきました。`,
  );
  const furthest = furthestUnmetSentence(dec);
  if (furthest) parts.push(furthest);
  return parts.join("");
}

type EntryDraft = Omit<NarrationEntry, "id">;

function eventKey(e: OperationsSnapshot["events"][number]): string {
  return `e:${e.timestamp}:${e.kind}:${e.code}:${e.apiFailure?.api ?? ""}:${e.apiFailure?.operation ?? ""}:${e.apiFailure?.code ?? ""}`;
}
function candidateKey(c: OperationsSnapshot["candidates"][number]): string {
  return `c:${c.id}:${c.finalAction}`;
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
      text: `安全停止中です。理由：${stopReasonText(d)}`,
    };
  if (vitalState === "sleeping")
    return d.stopReason
      ? {
          at: now,
          kind: "stop",
          text: `停止中です。理由：${stopReasonText(d)}`,
        }
      : {
          at: now,
          kind: "status",
          text: "停止中です。開始操作を待っています。",
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
      text: "稼働中です。市場データの取得と判定を続けています。",
    };
  }
  return {
    at: now,
    kind: "status",
    text: "状態を確認中です。最新の記録が届くまで実況は止まります。",
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
  const drafts: EntryDraft[] = [];
  let narratedStop = false;
  let narratedPaused = false;
  let narratedRecovered = false;

  if (!prev.initialized) {
    for (const e of d.events ?? []) seen.add(eventKey(e));
    for (const c of d.candidates ?? []) seen.add(candidateKey(c));
    drafts.push(initialEntry(d, vitalState, now));
    return finish(
      {
        ...prev,
        seen: [...seen],
        lastDecisionAt: d.decision?.evaluatedAt ?? null,
        prevDecisionPrice: d.decision?.price ?? null,
        lastConnectivity: d.safety?.connectivity ?? null,
        lastStatus: d.status ?? null,
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
    seen.add(key);
    if (e.kind === "STOP") {
      narratedStop = true;
      drafts.push({
        at: e.timestamp,
        kind: "stop",
        text:
          e.code === "MANUAL_STOP"
            ? "手動で停止されました。"
            : `止まりました。理由：${operationReason(e.code)}`,
      });
    } else if (e.kind === "BOOT") {
      drafts.push({
        at: e.timestamp,
        kind: "status",
        text: "再起動しました。開始は手動操作を待っています。",
      });
    } else if (e.kind === "CONTROL") {
      if (e.code === "MANUAL_START") {
        drafts.push({
          at: e.timestamp,
          kind: "start",
          text: "PAPER運用を開始しました。",
        });
      } else if (e.code === "PAPER_NETWORK_RECOVERED") {
        narratedRecovered = true;
        drafts.push({
          at: e.timestamp,
          kind: "recovery",
          text: "通信の復旧が確認でき、PAPER運用を再開しました。",
        });
      } else if (e.code === "PAPER_NETWORK_PAUSED") {
        narratedPaused = true;
        drafts.push({
          at: e.timestamp,
          kind: "warning",
          text: "通信障害を検出したため、注文を一時停止しました。",
        });
      } else if (e.code === "MANUAL_RESET") {
        drafts.push({
          at: e.timestamp,
          kind: "status",
          text: "停止状態が手動で解除されました。",
        });
      }
    } else if (e.kind === "API" && e.apiFailure) {
      drafts.push({
        at: e.timestamp,
        kind: "warning",
        text: `${e.apiFailure.api}の通信に失敗しました（${operationReason(e.apiFailure.code)}）。`,
      });
    } else if (e.kind === "ANOMALY" && e.fatal) {
      drafts.push({
        at: e.timestamp,
        kind: "warning",
        text: `異常を検出しました：${operationReason(e.code)}`,
      });
    } else if (e.kind === "ERROR" && !apiTimestamps.has(e.timestamp)) {
      // An API event at the same timestamp already told this story.
      drafts.push({
        at: e.timestamp,
        kind: "warning",
        text: `処理中にエラーが発生しました：${operationReason(e.code)}`,
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
    if (seen.has(key)) {
      seen.delete(key);
      seen.add(key);
      continue;
    }
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
        text: `PAPERで${c.finalAction === "BUY" ? "買い" : "売り"}を記録しました${fill ? `：${fill}` : ""}。`,
      });
    } else if (c.finalAction === "WAIT") {
      const reason = c.reasons[0]
        ? operationReason(c.reasons[0])
        : "条件を確認できませんでした";
      drafts.push({
        at: c.timestamp,
        kind: "rejection",
        text: `${c.side === "BUY" ? "買い" : "売り"}シグナルは出ましたが、見送りました（${reason}）。`,
      });
    } else if (c.finalAction === "SAFE_STOP") {
      narratedStop = true;
      const reason = c.reasons[0]
        ? operationReason(c.reasons[0])
        : "安全条件を確認できませんでした";
      drafts.push({
        at: c.timestamp,
        kind: "stop",
        text: `候補の処理中に安全停止しました（${reason}）。`,
      });
    }
    // PENDING candidates are not final yet: stay silent.
  }

  // --- strategy cycle, from the decision evidence --------------------
  let lastDecisionAt = prev.lastDecisionAt;
  let prevDecisionPrice = prev.prevDecisionPrice;
  let priceRising = prev.priceRising;
  const dec = d.decision;
  if (dec && (lastDecisionAt == null || dec.evaluatedAt > lastDecisionAt)) {
    if (
      (vitalState === "alive" || vitalState === "weak") &&
      freshDecision(dec, now)
    ) {
      drafts.push({
        at: dec.evaluatedAt,
        kind: "cycle",
        text: cycleNarrationText(dec, prevDecisionPrice),
      });
    }
    priceRising = prevDecisionPrice != null && dec.price > prevDecisionPrice;
    prevDecisionPrice = dec.price;
    lastDecisionAt = dec.evaluatedAt;
  }

  // --- connectivity transitions --------------------------------------
  let lastConnectivity = prev.lastConnectivity;
  const connectivity = d.safety?.connectivity ?? null;
  if (connectivity && lastConnectivity && connectivity !== lastConnectivity) {
    if (connectivity === "DEGRADED" && !narratedPaused)
      drafts.push({
        at: now,
        kind: "warning",
        text: "通信が不安定になっています。復旧するまで新規注文は止まっています。",
      });
    else if (connectivity === "RECOVERING")
      drafts.push({
        at: now,
        kind: "status",
        text: `通信の復旧を確認中です（正常サイクル${d.safety.healthyCycles}回を確認）。`,
      });
    else if (connectivity === "HEALTHY" && !narratedRecovered)
      drafts.push({
        at: now,
        kind: "recovery",
        text: "通信が復旧しました。",
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
        text: `止まりました。理由：${stopReasonText(d)}`,
      });
  }
  if (d.status) lastStatus = d.status;

  return finish(
    {
      ...prev,
      seen: [...seen],
      lastDecisionAt,
      prevDecisionPrice,
      priceRising,
      lastConnectivity,
      lastStatus,
    },
    drafts,
  );
}

function finish(state: NarrationState, drafts: EntryDraft[]): NarrationState {
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
 * - running but degraded / recovering, or state unknown -> normal
 *   (an abnormal-but-awake bot does not celebrate)
 * - the newest entry is a recorded fill -> pointSmile
 * - a buy signal just fired, or at least two entry conditions are met
 *   (with the price also rising since the previous cycle when only
 *   one is met) -> point （指立て）
 * - otherwise -> normal
 */
export function agentPose(
  state: NarrationState,
  d: OperationsSnapshot,
  vital: BotVital,
  now = Date.now(),
): AgentPose {
  if (vital.state === "sleeping" || vital.state === "flatlined") return "sleep";
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
    if (dec.action === "BUY") return "point";
    const met = metEntryConditions(dec);
    if (met >= 2) return "point";
    if (met >= 1 && state.priceRising) return "point";
  }
  return "normal";
}
