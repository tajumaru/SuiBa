import { z } from "zod";
import type { Candle } from "../../../packages/shared/src/index.ts";
import type { ChartForecast } from "./chartForecast.ts";

/**
 * A running score for the chart's model outlook (5-minute
 * timeframe only — the calibrated one). Every time a new forecast
 * origin appears while the app is open, the cone is snapshotted
 * to this device; later, once the real candles exist, the log is
 * scored against them:
 *
 * - coverage: the share of projected steps whose actual close
 *   landed inside the cone (the cone's own claim);
 * - direction: only for forecasts that named a direction, whether
 *   the final close landed on the named side of the start close
 *   (「横ばい気味」 forecasts make no direction claim and are
 *   never scored for one).
 *
 * Forecasts made while the app was closed are simply absent —
 * the score line says so. Display only; nothing here feeds the
 * bot.
 */
export interface ForecastRecord {
  /** Start time (seconds) of the first projected candle. */
  origin: number;
  startClose: number;
  dir: "up" | "down" | "flat";
  up: number[];
  lo: number[];
  /** The cone's centre line per step. Present only on records
   * written since the answer-check view arrived; older records
   * carry the bounds alone and cannot be redrawn. */
  mid?: number[];
  /** Book-tilt share of the drift when recorded (fraction of
   * startClose); null for records from before the tilt and
   * for untilted forecasts. Lets the score judge the tilt on
   * live outcomes later. */
  tilt?: number | null;
  /** Touch target snapshotted with the forecast: the line in
   * the claimed direction and its measured probability.
   * Absent on records from before touch targets and on flat
   * forecasts. */
  touch?: { line: number; prob: number } | null;
}

export const MAX_FORECAST_RECORDS = 288;
export const MIN_SCORED_RECORDS = 10;

const round6 = (n: number) => Number(n.toFixed(6));

/** Snapshot a forecast. The caller passes the last real close
 * the forecast grew from (it cannot be recovered exactly from
 * the projected points, whose first mid is already one damped
 * step away). */
export function forecastRecordFrom(
  fc: ChartForecast,
  startClose: number,
): ForecastRecord {
  return {
    origin: fc.points[0].timestamp,
    startClose: round6(startClose),
    dir: fc.direction,
    up: fc.points.map((p) => round6(p.upper)),
    lo: fc.points.map((p) => round6(p.lower)),
    mid: fc.points.map((p) => round6(p.mid)),
    tilt: fc.bookTiltPct === 0 ? null : round6(fc.bookTiltPct),
    touch: fc.touch
      ? { line: round6(fc.touch.linePrice), prob: fc.touch.prob }
      : null,
  };
}

/** Append a record unless its origin is already logged. Returns
 * the same array reference when nothing changed. */
export function appendForecastRecord(
  records: ForecastRecord[],
  rec: ForecastRecord,
): ForecastRecord[] {
  if (records.some((r) => r.origin === rec.origin)) return records;
  const next = [...records, rec].sort((a, b) => a.origin - b.origin);
  return next.slice(-MAX_FORECAST_RECORDS);
}

const KEY = "suiba.forecastLog.v1";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
const num = z.number().finite().positive();
const recordSchema = z.object({
  origin: num,
  startClose: num,
  dir: z.enum(["up", "down", "flat"]),
  up: z.array(num).min(1).max(48),
  lo: z.array(num).min(1).max(48),
  mid: z.array(num).min(1).max(48).optional(),
  tilt: z.number().nullable().optional(),
  touch: z
    .object({ line: num, prob: z.number().min(0).max(1) })
    .nullable()
    .optional(),
});
const schema = z.array(recordSchema).max(MAX_FORECAST_RECORDS);

// Per pair, like the narration log: SUI keeps the bare key.
function keyFor(pair: string): string {
  return pair === "SUI_USDC" ? KEY : `${KEY}:${pair}`;
}

export function loadForecastLog(
  pair: string,
  storage?: StorageAccess,
): ForecastRecord[] {
  try {
    const raw = (storage ?? window.localStorage).getItem(keyFor(pair));
    if (!raw || raw.length > 500_000) return [];
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

export function saveForecastLog(
  records: ForecastRecord[],
  pair: string,
  storage?: StorageAccess,
): void {
  try {
    (storage ?? window.localStorage).setItem(
      keyFor(pair),
      JSON.stringify(records),
    );
  } catch {
    // A full or denied storage must not interrupt the dashboard.
  }
}

export interface ForecastScore {
  scoredRecords: number;
  steps: number;
  coveragePct: number | null;
  dirTotal: number;
  dirPct: number | null;
  /** Touch targets whose horizon has closed (or that were
   * touched early), and how many of them were reached. */
  touchTotal: number;
  touchHits: number;
}

export function scoreForecasts(
  records: ForecastRecord[],
  candles: Candle[],
  timeframe = 300,
): ForecastScore {
  const closeAt = new Map(candles.map((c) => [c.timestamp, c.close]));
  let steps = 0,
    hits = 0,
    scoredRecords = 0,
    dirTotal = 0,
    dirHits = 0;
  for (const r of records) {
    let own = 0;
    for (let j = 0; j < r.up.length; j++) {
      const close = closeAt.get(r.origin + j * timeframe);
      if (close == null) continue;
      own++;
      steps++;
      if (close >= r.lo[j] && close <= r.up[j]) hits++;
      if (j === r.up.length - 1 && r.dir !== "flat") {
        dirTotal++;
        if (
          (r.dir === "up" && close > r.startClose) ||
          (r.dir === "down" && close < r.startClose)
        )
          dirHits++;
      }
    }
    if (own > 0) scoredRecords++;
  }
  let touchTotal = 0,
    touchHits = 0;
  for (const r of records) {
    const t = forecastTouchStateOf(r, candles, timeframe);
    if (!t || t.phase === "pending") continue;
    touchTotal++;
    if (t.phase === "touched") touchHits++;
  }
  return {
    scoredRecords,
    steps,
    coveragePct: steps ? Math.round((hits / steps) * 100) : null,
    dirTotal,
    dirPct: dirTotal ? Math.round((dirHits / dirTotal) * 100) : null,
    touchTotal,
    touchHits,
  };
}

/** One finished forecast, ready to be laid over what actually
 * happened: the recorded cone (ghost) plus the real closes. */
export interface ForecastAnswerCheck {
  /** Start time (seconds) of the first projected candle. */
  origin: number;
  startClose: number;
  dir: "up" | "down" | "flat";
  /** Projected drift over the horizon, as a fraction. */
  driftPct: number;
  /** Realised change over the same window, as a fraction. */
  actualPct: number;
  /** Share of steps whose real close stayed inside the cone. */
  coveragePct: number;
  /** Direction verdict; null when none was claimed (flat). */
  directionHit: boolean | null;
  points: { timestamp: number; mid: number; upper: number; lower: number }[];
  actuals: { timestamp: number; close: number }[];
}

/** The newest forecast that can be answer-checked: it carries
 * its centre line, every projected step has a real candle, and
 * the whole story still sits in the chart's recent window (the
 * origin candle within the last 48 bars). Older records without
 * a centre line are skipped — they were never drawn with one
 * stored, so there is nothing honest to redraw. */
export function latestAnswerCheck(
  records: ForecastRecord[],
  candles: Candle[],
  timeframe = 300,
): ForecastAnswerCheck | null {
  const latest = candles.at(-1);
  if (!latest) return null;
  const closeAt = new Map(candles.map((c) => [c.timestamp, c.close]));
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!r.mid || r.mid.length !== r.up.length || r.up.length === 0)
      continue;
    if (r.origin - timeframe < latest.timestamp - 47 * timeframe) continue;
    const points: ForecastAnswerCheck["points"] = [];
    const actuals: ForecastAnswerCheck["actuals"] = [];
    let covered = 0;
    let complete = true;
    for (let j = 0; j < r.up.length; j++) {
      const ts = r.origin + j * timeframe;
      const close = closeAt.get(ts);
      if (close == null) {
        complete = false;
        break;
      }
      points.push({
        timestamp: ts,
        mid: r.mid[j],
        upper: r.up[j],
        lower: r.lo[j],
      });
      actuals.push({ timestamp: ts, close });
      if (close >= r.lo[j] && close <= r.up[j]) covered++;
    }
    if (!complete || actuals.length === 0) continue;
    const lastClose = actuals.at(-1)!.close;
    return {
      origin: r.origin,
      startClose: r.startClose,
      dir: r.dir,
      driftPct: (r.mid.at(-1)! - r.startClose) / r.startClose,
      actualPct: (lastClose - r.startClose) / r.startClose,
      coveragePct: Math.round((covered / actuals.length) * 100),
      directionHit:
        r.dir === "flat"
          ? null
          : r.dir === "up"
            ? lastClose > r.startClose
            : lastClose < r.startClose,
      points,
      actuals,
    };
  }
  return null;
}

const priceText = (v: number) =>
  `$${v >= 10 ? v.toFixed(2) : v.toFixed(4)}`;
const pctText = (frac: number) =>
  `${frac >= 0 ? "+" : ""}${(frac * 100).toFixed(1)}%`;

export function answerCheckText(check: ForecastAnswerCheck): string {
  const head = "答え合わせ（2時間前の予測）：";
  if (check.directionHit == null)
    return `${head}方向は名乗らず ／ コーン収まり ${check.coveragePct}%`;
  return `${head}方向 ${check.directionHit ? "的中" : "外れ"}（予測 ${pctText(check.driftPct)} → 実際 ${pctText(check.actualPct)}）／ コーン収まり ${check.coveragePct}%`;
}

/** The projected drift of a recorded forecast, as a fraction;
 * null for the older records that carry no centre line. */
export function forecastDriftPct(rec: ForecastRecord): number | null {
  if (!rec.mid || rec.mid.length === 0) return null;
  return (rec.mid.at(-1)! - rec.startClose) / rec.startClose;
}

export interface ForecastVerdict {
  origin: number;
  dir: "up" | "down";
  /** What the forecast claimed, as a fraction. */
  driftPct: number;
  /** What actually happened over the horizon, as a fraction. */
  actualPct: number;
  hit: boolean;
  /** When the horizon closed (ms since epoch): the first
   * candle after the last projected step begins. */
  completedAt: number;
}

/**
 * The verdict of one recorded forecast, once its horizon has
 * fully closed — the same judgement the score and the answer
 * check make: the final close against the start close, and only
 * for forecasts that named a direction. Null while the horizon
 * is still open (the final candle must itself be closed, so a
 * later candle has to exist), for flat forecasts, and for
 * records without a centre line.
 */
export function forecastVerdictOf(
  rec: ForecastRecord,
  candles: readonly Candle[],
  timeframe = 300,
): ForecastVerdict | null {
  if (rec.dir === "flat") return null;
  const driftPct = forecastDriftPct(rec);
  if (driftPct == null || rec.up.length === 0) return null;
  const lastStep = rec.origin + (rec.up.length - 1) * timeframe;
  const closeAt = new Map(candles.map((c) => [c.timestamp, c.close]));
  const finalClose = closeAt.get(lastStep);
  if (finalClose == null) return null;
  const latest = candles.at(-1);
  if (!latest || latest.timestamp <= lastStep) return null;
  return {
    origin: rec.origin,
    dir: rec.dir,
    driftPct,
    actualPct: (finalClose - rec.startClose) / rec.startClose,
    hit:
      rec.dir === "up"
        ? finalClose > rec.startClose
        : finalClose < rec.startClose,
    completedAt: (lastStep + timeframe) * 1000,
  };
}

/** The declaration line for a direction-claiming forecast:
 * the claim, the size, and when the answer arrives. */
export function forecastCallText(rec: ForecastRecord): string {
  const drift = forecastDriftPct(rec);
  const word = rec.dir === "up" ? "上昇" : "下落";
  const touch = rec.touch
    ? `${priceText(rec.touch.line)}（${pctText((rec.touch.line - rec.startClose) / rec.startClose)}）にタッチする確率は${Math.round(rec.touch.prob * 100)}%。`
    : "";
  return drift != null
    ? `予測を宣言：2時間で${word} ${pctText(drift)} と見てる。${touch}答え合わせは2時間後`
    : `予測を宣言：2時間で${word}と見てる。${touch}答え合わせは2時間後`;
}

/** The verdict line for a declared forecast: the recorded
 * claim against the recorded outcome, nothing embroidered. */
export function forecastVerdictText(v: ForecastVerdict): string {
  const word = v.dir === "up" ? "上昇" : "下落";
  return v.hit
    ? `予測、的中。${word} ${pctText(v.driftPct)} の宣言どおり、実際は ${pctText(v.actualPct)}`
    : `予測は外れ。${word} ${pctText(v.driftPct)} と言ったけど、実際は ${pctText(v.actualPct)}`;
}

export interface ForecastTouchState {
  origin: number;
  dir: "up" | "down";
  line: number;
  prob: number;
  phase: "pending" | "touched" | "expired";
  /** Remaining distance from the closest approach so far
   * (fraction of the extreme price; 0 once touched). */
  closestAwayPct: number;
  /** Remaining distance from the newest close in the window
   * (fraction; negative once the close itself is past). */
  awayPct: number | null;
  /** When the horizon ends (ms since epoch). */
  endsAt: number;
}

/** A touch settles as "near" when the closest approach came
 * within this distance of the line without reaching it. */
export const TOUCH_NEAR_PCT = 0.003;

/**
 * The live state of one record's touch target. A touch is a
 * fact about highs and lows, so it can settle before the
 * horizon closes — a printed extreme never un-prints. Expiry
 * follows the verdict's closure rule (a later candle must
 * exist), so stale data settles nothing. Null for records
 * without a target.
 */
export function forecastTouchStateOf(
  rec: ForecastRecord,
  candles: readonly Candle[],
  timeframe = 300,
): ForecastTouchState | null {
  if (!rec.touch || rec.dir === "flat" || rec.up.length === 0)
    return null;
  const line = rec.touch.line;
  const lastStep = rec.origin + (rec.up.length - 1) * timeframe;
  let best: number | null = null;
  let lastClose: number | null = null;
  for (const c of candles) {
    if (c.timestamp < rec.origin || c.timestamp > lastStep) continue;
    const extreme = rec.dir === "up" ? c.high : c.low;
    best =
      best === null
        ? extreme
        : rec.dir === "up"
          ? Math.max(best, extreme)
          : Math.min(best, extreme);
    lastClose = c.close;
  }
  const touched =
    best !== null &&
    (rec.dir === "up" ? best >= line : best <= line);
  const latest = candles.at(-1);
  const closed = latest != null && latest.timestamp > lastStep;
  return {
    origin: rec.origin,
    dir: rec.dir,
    line,
    prob: rec.touch.prob,
    phase: touched ? "touched" : closed ? "expired" : "pending",
    closestAwayPct:
      best === null
        ? Math.abs(line / rec.startClose - 1)
        : touched
          ? 0
          : Math.abs(line / best - 1),
    awayPct:
      lastClose === null
        ? null
        : rec.dir === "up"
          ? line / lastClose - 1
          : 1 - line / lastClose,
    endsAt: (lastStep + timeframe) * 1000,
  };
}

/** Settlement line when the line was reached. */
export function forecastTouchText(t: ForecastTouchState): string {
  return `タッチ！${priceText(t.line)} に届いた（確率は${Math.round(t.prob * 100)}%だった）`;
}

/** Settlement line when the horizon closed just short. */
export function forecastTouchNearText(t: ForecastTouchState): string {
  return `タッチならず。${priceText(t.line)} まで あと${(t.closestAwayPct * 100).toFixed(2)}% のところで時間切れ（確率は${Math.round(t.prob * 100)}%）`;
}

/** The chart's live status line for the newest open (or just
 * touched) target; null when there is nothing to follow. */
export function touchStatusText(t: ForecastTouchState, now: number): string {
  if (t.phase === "touched")
    return `タッチ予測：${priceText(t.line)} にタッチ済み`;
  const remainMin = Math.max(
    0,
    Math.round((t.endsAt - now) / 60000),
  );
  const remain =
    remainMin >= 60
      ? `${Math.floor(remainMin / 60)}:${String(remainMin % 60).padStart(2, "0")}`
      : `${remainMin}分`;
  const away =
    t.awayPct === null
      ? ""
      : ` まで あと ${t.awayPct >= 0 ? "+" : "−"}${Math.abs(t.awayPct * 100).toFixed(2)}%`;
  return `タッチ予測：${priceText(t.line)}${away}（残り ${remain}）`;
}

export function forecastScoreText(
  score: ForecastScore,
  recordCount: number,
): string | null {
  if (recordCount === 0) return null;
  if (score.scoredRecords < MIN_SCORED_RECORDS || score.coveragePct == null)
    return `予測の成績：集計中（判定 ${score.scoredRecords} 件、${MIN_SCORED_RECORDS} 件から表示）`;
  const direction =
    score.dirTotal >= MIN_SCORED_RECORDS && score.dirPct != null
      ? `・方向の的中 ${score.dirPct}%（${score.dirTotal} 件）`
      : "・方向は集計中";
  const touch =
    score.touchTotal >= MIN_SCORED_RECORDS
      ? `・タッチ到達 ${score.touchHits}/${score.touchTotal} 件`
      : "";
  return `予測の成績：コーン収まり ${score.coveragePct}%（判定 ${score.scoredRecords} 件）${direction}${touch} ※アプリを開いていた間の予測だけを集計`;
}
