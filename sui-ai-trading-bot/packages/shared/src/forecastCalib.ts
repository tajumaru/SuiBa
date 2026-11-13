import { z } from "zod";
import type { ForecastScore } from "./forecastLog.ts";

/**
 * Forecast self-calibration: the cone learns from its own
 * scored record. The cone's empirical shape targets 80%
 * coverage (its 10%/90% error quantiles); worker-scored forecasts say what coverage the cone is
 * actually delivering, and a single width
 * scale is nudged toward the target in small damped steps.
 *
 * Bounds that keep the learning honest and slow:
 * - nothing moves before 30 scored forecasts, and each
 *   further step needs a fresh batch of 10;
 * - a ±3-point deadband around the target stays quiet;
 * - each step moves at most half the coverage error, and
 *   the scale is clamped to [0.7, 1.5] and rounded to 0.01,
 *   so the cone can never run away from the measured shape;
 * - only the WIDTH learns. The drift — what the model
 *   claims — is never fitted to outcomes here.
 *
 * Per pair in bot.sqlite. Legacy device storage is read only for migration.
 * Display only: the scale shapes the drawn and recorded
 * cone (records snapshot the scaled cone, so verdicts judge
 * exactly what was shown); nothing feeds the bot.
 */
export interface ForecastCalib {
  /** Width multiplier on the measured cone shape. */
  scale: number;
  /** Scored-record count at the last evaluation. */
  scoredAt: number;
}

export interface CalibEvent {
  /** When the scale last changed (ms). */
  at: number;
  /** Stable worker event identity (legacy events have none). */
  id?: string;
  previousScale?: number;
  scale: number;
  scored: number;
  coveragePct: number;
  widened: boolean;
}

export const CALIB_TARGET_COVERAGE_PCT = 80;
export const CALIB_MIN_SCORED = 30;
export const CALIB_BATCH = 10;
export const CALIB_DEADBAND_PCT = 3;
export const CALIB_MIN_SCALE = 0.7;
export const CALIB_MAX_SCALE = 1.5;

const round2 = (n: number) => Math.round(n * 100) / 100;

export function emptyCalib(): ForecastCalib {
  return { scale: 1, scoredAt: 0 };
}

/**
 * One evaluation of the scored record against the current
 * calibration. Returns the SAME object when no batch is due;
 * a new object with an advanced scoredAt when a batch was
 * evaluated (scale possibly unchanged inside the deadband),
 * so callers can tell "evaluated" from "changed" via
 * `changed` and persist either way.
 */
export function calibrationStep(
  score: ForecastScore,
  calib: ForecastCalib,
): { calib: ForecastCalib; changed: boolean } {
  if (
    score.coveragePct == null ||
    score.scoredRecords < CALIB_MIN_SCORED ||
    score.scoredRecords < calib.scoredAt + CALIB_BATCH
  )
    return { calib, changed: false };
  const err = (score.coveragePct - CALIB_TARGET_COVERAGE_PCT) / 100;
  if (Math.abs(err) * 100 <= CALIB_DEADBAND_PCT)
    return { calib: { ...calib, scoredAt: score.scoredRecords }, changed: false };
  const next = round2(
    Math.min(
      CALIB_MAX_SCALE,
      Math.max(CALIB_MIN_SCALE, calib.scale * (1 - err * 0.5)),
    ),
  );
  return {
    calib: { scale: next, scoredAt: score.scoredRecords },
    changed: next !== calib.scale,
  };
}

/** The narration line for a calibration change: the record it
 * stands on, nothing embroidered. */
export function calibText(e: CalibEvent): string {
  return e.widened
    ? `学習：ここまでの予測${e.scored}件、収まり率は${e.coveragePct}%で目標の${CALIB_TARGET_COVERAGE_PCT}%より狭かった。予測の幅を少し広げたよ（×${e.scale.toFixed(2)}）`
    : `学習：ここまでの予測${e.scored}件、収まり率は${e.coveragePct}%で目標の${CALIB_TARGET_COVERAGE_PCT}%より広かった。予測の幅を少し狭めたよ（×${e.scale.toFixed(2)}）`;
}

const KEY = "suiba.forecastCalib.v1";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
const schema = z.object({
  scale: z.number().min(CALIB_MIN_SCALE).max(CALIB_MAX_SCALE),
  scoredAt: z.number().int().nonnegative(),
});

function keyFor(pair: string): string {
  return pair === "SUI_USDC" ? KEY : `${KEY}:${pair}`;
}

export function loadForecastCalib(
  pair: string,
  storage?: StorageAccess,
): ForecastCalib {
  try {
    const raw = (storage ?? window.localStorage).getItem(keyFor(pair));
    if (!raw) return emptyCalib();
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : emptyCalib();
  } catch {
    return emptyCalib();
  }
}

export function saveForecastCalib(
  calib: ForecastCalib,
  pair: string,
  storage?: StorageAccess,
): void {
  try {
    (storage ?? window.localStorage).setItem(
      keyFor(pair),
      JSON.stringify(calib),
    );
  } catch {
    // A full or denied storage must not interrupt the dashboard.
  }
}
