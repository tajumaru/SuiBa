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
  return {
    scoredRecords,
    steps,
    coveragePct: steps ? Math.round((hits / steps) * 100) : null,
    dirTotal,
    dirPct: dirTotal ? Math.round((dirHits / dirTotal) * 100) : null,
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

const pctText = (frac: number) =>
  `${frac >= 0 ? "+" : ""}${(frac * 100).toFixed(1)}%`;

export function answerCheckText(check: ForecastAnswerCheck): string {
  const head = "答え合わせ（2時間前の予測）：";
  if (check.directionHit == null)
    return `${head}方向は名乗らず ／ コーン収まり ${check.coveragePct}%`;
  return `${head}方向 ${check.directionHit ? "的中" : "外れ"}（予測 ${pctText(check.driftPct)} → 実際 ${pctText(check.actualPct)}）／ コーン収まり ${check.coveragePct}%`;
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
  return `予測の成績：コーン収まり ${score.coveragePct}%（判定 ${score.scoredRecords} 件）${direction} ※アプリを開いていた間の予測だけを集計`;
}
