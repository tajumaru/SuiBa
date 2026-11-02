import type { DecisionTelemetry } from "../../../worker/src/operations.ts";
import type { DecisionTrail, EntryCondKey, WatchTarget } from "./state.ts";
import { number as fmtNumber, percent as fmtPercent } from "../presentation.ts";
import { price, signedPct } from "./format.ts";

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
export const VOLUME_MULTIPLE_THRESHOLD = 9;
export const volumeMultiple = (ratio: number): number | null =>
  Number.isFinite(ratio) && ratio >= VOLUME_MULTIPLE_THRESHOLD
    ? Math.round(ratio + 1)
    : null;

/** The three strategy entry conditions, in display order. */
export function entryConditions(dec: DecisionTelemetry) {
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
export function unmetDistance(
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
export const COND_SHORT: Record<EntryCondKey, string> = {
  emaUp: "EMA",
  rsiRecovery: "RSI",
  histogramImproving: "MACD",
};

export const emaGapPct = (v: { price: number; ema20: number; ema50: number }) =>
  fmtPercent(v.price > 0 ? (v.ema20 - v.ema50) / v.price : 0);
export const rsiPoints = (rsi: number, oversold: number) =>
  Math.max(0, Math.round(rsi - oversold));

/**
 * Per-key distance used ONLY to compare the same condition across two
 * cycles (did it approach since last time?). Scales differ per key
 * and are never shown as numbers.
 */
export function trailDistance(key: EntryCondKey, t: DecisionTrail): number {
  if (key === "emaUp") return t.price > 0 ? (t.ema50 - t.ema20) / t.price : 0;
  if (key === "rsiRecovery") return t.rsi - t.oversold;
  return -t.histogram;
}

/**
 * The MACD histogram in words. Its raw value is meaningless at 基軸通貨
 * prices (0.0001 reads as precision without information), so the
 * narration names only the side of zero — and "ほぼゼロ" inside the
 * ATR-relative band the last-piece line already used. The exact
 * histogram stays in the operations diagnostics.
 */
export function macdWord(dec: { histogram: number; atr: number }): string {
  if (dec.atr > 0 && Math.abs(dec.histogram) <= dec.atr * 0.05)
    return "ほぼゼロ";
  return dec.histogram < 0 ? "マイナス側" : "プラス側";
}

/** Number-carrying phrase for one unmet entry condition. */
export function unmetNumberPhrase(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp") return `EMAの差は${emaGapPct(dec)}`;
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? `RSIは${fmtNumber(dec.rsi, 1)}で圏内、上抜け待ち`
      : `RSI ${fmtNumber(dec.rsi, 1)}、ラインまでまだ${rsiPoints(dec.rsi, dec.oversold)}`;
  return `MACDは${macdWord(dec)}`;
}

/** Number-free aside naming a second unmet entry condition. */
export function unmetAside(key: EntryCondKey, dec: DecisionTelemetry): string {
  if (key === "emaUp") return "EMAもまだ逆並びだし";
  if (key === "rsiRecovery")
    return dec.rsi <= dec.oversold
      ? "RSIは圏内で待ってるし"
      : "RSIもまだ高めだし";
  return dec.histogram < 0 ? "MACDもマイナス側だし" : "MACDも下向きだし";
}

/** The one remaining condition, named with its recorded number. */
export function singleRemainingText(
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
    return `あとMACDだけ。ほぼゼロ。次で揃うかも`;
  if (dec.histogram < 0) return `あとMACDだけ。まだマイナス側だね`;
  return `あとMACDだけ。プラス圏だけど、下向きだね`;
}

/**
 * WAIT-cycle narration: short and soft, but always grounded — one
 * recorded number, the missing condition named, and the change since
 * the previous cycle (a condition that broke is the headline, then a
 * single remaining condition, then a newly met one, then progress).
 */
export function waitNarration(
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
        ? `EMAの差の縮小が止まった。差は${emaGapPct(dec)}`
        : `EMAの並びが崩れた。差は${emaGapPct(dec)}`;
    if (key === "rsiRecovery")
      return `RSIの上向きが崩れた。今は${fmtNumber(dec.rsi, 1)}`;
    return `MACDの上向きが崩れた`;
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
            : `MACDが${macdWord(dec)}で上向いた`;
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
export function watchDistance(key: EntryCondKey, dec: DecisionTelemetry): number {
  if (key === "emaUp")
    return dec.price > 0 ? (dec.ema50 - dec.ema20) / dec.price : 0;
  if (key === "rsiRecovery") return dec.rsi - dec.oversold;
  return -dec.histogram;
}

/** Current distance as a ratio of the declared baseline. */
export function watchRatio(watch: WatchTarget, dec: DecisionTelemetry): number {
  const current = watchDistance(watch.key, dec);
  if (watch.declaredDistance <= 0) return current <= 0 ? 0 : 1;
  return current / watch.declaredDistance;
}

/**
 * The open position's sell lines from a decision, or null when no
 * position is open (or the recorded percentages cannot form a sane
 * pair of lines). Display-only derivation from recorded values:
 * the take-profit and stop-loss prices the strategy itself uses.
 */
export function sellLinesOf(dec: {
  entryPrice: number | null;
  takeProfitPct: number;
  stopLossPct: number;
}): { tp: number; sl: number } | null {
  if (dec.entryPrice == null || !(dec.entryPrice > 0)) return null;
  const tp = dec.entryPrice * (1 + dec.takeProfitPct);
  const sl = dec.entryPrice * (1 - dec.stopLossPct);
  return Number.isFinite(tp) &&
    Number.isFinite(sl) &&
    tp > dec.entryPrice &&
    sl > 0 &&
    sl < dec.entryPrice
    ? { tp, sl }
    : null;
}
