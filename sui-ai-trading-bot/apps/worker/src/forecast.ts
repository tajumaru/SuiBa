import { createHash } from "node:crypto";
import { z } from "zod";
import type { BotDatabase } from "../../../packages/database/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import {
  chartForecast,
  FORECAST_BARS,
} from "../../../packages/shared/src/chartForecast.ts";
import {
  calibrationStep,
  emptyCalib,
  type ForecastCalib,
  type CalibEvent,
} from "../../../packages/shared/src/forecastCalib.ts";
import {
  appendForecastRecord,
  forecastRecordFrom,
  scoreForecasts,
  latestAnswerCheck,
  forecastTouchStateOf,
  touchStatusText,
  forecastVerdictOf,
  forecastScoreText,
  forecastRecordSchema,
  type ForecastRecord,
} from "../../../packages/shared/src/forecastLog.ts";

const migrationSchema = z.object({
  records: z.array(forecastRecordSchema).max(288),
  calib: z.object({
    scale: z.number().min(0.7).max(1.5),
    scoredAt: z.number().int().nonnegative(),
  }),
});
const key = (pair: string) => `forecast.v1:${pair}`;
export interface ForecastState {
  records: ForecastRecord[];
  calib: ForecastCalib;
  latest: ReturnType<typeof chartForecast>;
  cones: Record<number, ReturnType<typeof chartForecast>>;
  score: ReturnType<typeof scoreForecasts>;
  answer: ReturnType<typeof latestAnswerCheck>;
  touchLine: string | null;
  scoreLine: string | null;
  events: CalibEvent[];
  migrationAdopted: boolean;
  updatedAt: number;
}
export function readForecast(db: BotDatabase, pair: string): ForecastState {
  return (
    db.get<ForecastState>(key(pair)) ?? {
      records: [],
      calib: emptyCalib(),
      latest: null,
      cones: {},
      score: scoreForecasts([], []),
      answer: null,
      touchLine: null,
      scoreLine: null,
      events: [],
      migrationAdopted: false,
      updatedAt: 0,
    }
  );
}
/** Runs only from acquisition, never from a GET or an open browser. */
export function advanceForecast(
  db: BotDatabase,
  pair: string,
  candles: Candle[],
  imbalance: number | null,
  now: number,
  frames: Record<number, Candle[]> = { 300: candles },
) {
  const before = readForecast(db, pair);
  const latest = chartForecast(
    candles,
    FORECAST_BARS,
    imbalance,
    before.calib.scale,
  );
  let records = before.records;
  if (latest && candles.length)
    records = appendForecastRecord(
      records,
      forecastRecordFrom(latest, candles.at(-1)!.close),
    );
  const score = scoreForecasts(records, candles);
  const step = calibrationStep(score, before.calib);
  const events = [...before.events];
  const event: CalibEvent | null =
    step.changed && score.coveragePct != null
      ? {
          id: `forecast-calib:${pair}:${now}:${score.scoredRecords}`,
          at: now,
          previousScale: before.calib.scale,
          scale: step.calib.scale,
          scored: score.scoredRecords,
          coveragePct: score.coveragePct,
          widened: step.calib.scale > before.calib.scale,
        }
      : null;
  if (event) events.push(event);
  const touch = records.at(-1)
    ? forecastTouchStateOf(records.at(-1)!, candles)
    : null;
  const line = forecastScoreText(score, records.length);
  const state: ForecastState = {
    ...before,
    records,
    calib: step.calib,
    latest: step.changed
      ? chartForecast(candles, FORECAST_BARS, imbalance, step.calib.scale)
      : latest,
    cones: Object.fromEntries(
      Object.entries(frames).map(([tf, rows]) => [
        tf,
        chartForecast(rows, FORECAST_BARS, imbalance, step.calib.scale),
      ]),
    ),
    score,
    answer: latestAnswerCheck(records, candles),
    touchLine:
      touch &&
      (touch.phase === "pending" ||
        (touch.phase === "touched" && now < touch.endsAt))
        ? touchStatusText(touch, now)
        : null,
    scoreLine:
      line && step.calib.scale !== 1
        ? `${line}（予測の幅は実績で学習中 ×${step.calib.scale.toFixed(2)}）`
        : line,
    events,
    updatedAt: now,
  };
  db.transaction(() => {
    for (const rec of records) {
      const id = `${pair}:${rec.origin}`;
      // Append-only archive: active scoring retains the original 288-record window.
      if (!db.get<boolean>(`forecast.archived:${id}`)) {
        db.append("forecast_records", id, { pair, ...rec }, now);
        db.set(`forecast.archived:${id}`, true);
      }
      const verdict = forecastVerdictOf(rec, candles);
      const completed =
        (candles.at(-1)?.timestamp ?? 0) >= rec.origin + rec.up.length * 300;
      if (
        completed &&
        scoreForecasts([rec], candles).steps === rec.up.length &&
        !db.get<boolean>(`forecast.answered:${id}`)
      ) {
        db.append(
          "forecast_answers",
          id,
          { pair, verdict, score: scoreForecasts([rec], candles) },
          now,
        );
        db.set(`forecast.answered:${id}`, true);
      }
    }
    if (event)
      db.append("forecast_calibrations", event.id!, { pair, ...event }, now);
    db.set(key(pair), state);
  });
  return state;
}
/** Payload content identity makes retries and multiple tabs idempotent.
 * First nonempty legacy state owns the initial scale; later conflicting
 * devices are archived with their full payload and explicit disposition. */
export function importForecast(
  db: BotDatabase,
  pair: string,
  input: unknown,
  now: number,
) {
  const parsed = migrationSchema.safeParse(input);
  if (!parsed.success) throw Error("INVALID_FORECAST_MIGRATION");
  const payload = parsed.data;
  const id = createHash("sha256")
    .update(JSON.stringify({ pair, ...payload }))
    .digest("hex");
  const previous = db.get<{ id: string; disposition: string }>(
    `forecast.import:${id}`,
  );
  if (previous) return previous;
  const before = readForecast(db, pair);
  const meaningful =
    payload.records.length > 0 ||
    payload.calib.scale !== 1 ||
    payload.calib.scoredAt > 0;
  const adopt = meaningful && !before.migrationAdopted;
  const receipt = {
    id,
    disposition: adopt ? "adopted" : meaningful ? "archived" : "empty",
  };
  db.transaction(() => {
    db.append(
      "forecast_imports",
      id,
      { pair, at: now, ...receipt, payload },
      now,
    );
    db.set(`forecast.import:${id}`, receipt);
    if (!meaningful) return;
    const byOrigin = new Map(payload.records.map((r) => [r.origin, r]));
    for (const r of before.records) byOrigin.set(r.origin, r);
    for (const rec of payload.records)
      db.append(
        "forecast_records",
        `legacy:${id}:${rec.origin}`,
        { pair, ...rec, migrationId: id },
        now,
      );
    db.set(key(pair), {
      ...before,
      records: [...byOrigin.values()]
        .sort((a, b) => a.origin - b.origin)
        .slice(-288),
      calib: adopt ? payload.calib : before.calib,
      migrationAdopted: before.migrationAdopted || adopt,
      // Never display a cone computed using a superseded scale.
      latest: adopt ? null : before.latest,
      cones: adopt ? {} : before.cones,
    });
  });
  return receipt;
}
