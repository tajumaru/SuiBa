import { useEffect, useMemo, useRef, useState } from "react";
import type { BotEngine } from "../../worker/src/engine.ts";
import { chartForecast, FORECAST_BARS } from "./chartForecast.ts";
import {
  appendForecastRecord,
  forecastRecordFrom,
  forecastScoreText,
  forecastTouchStateOf,
  latestAnswerCheck,
  loadForecastLog,
  saveForecastLog,
  scoreForecasts,
  touchStatusText,
  type ForecastRecord,
} from "./forecastLog.ts";
import {
  calibrationStep,
  emptyCalib,
  loadForecastCalib,
  saveForecastCalib,
  type CalibEvent,
  type ForecastCalib,
} from "./forecastCalib.ts";
import { useAgentCharacter } from "./agentCharacter.ts";
import { shareCardInputFor } from "./shareCard.ts";

type State = ReturnType<BotEngine["snapshot"]>;

/**
 * The forecast suite, extracted from App: the device-local
 * forecast log (record every new 5-minute origin, score it
 * against the real candles), the cone's self-calibration, the
 * answer-check and touch-line derivations, and the share-card
 * input. Everything forecast-shaped the shell renders comes
 * from here; the narration feed and the chart only consume.
 */
export function useForecastSuite(data: State | null, agentName: string) {
  // Forecast score log (device-local, per pair): every new
  // 5-minute forecast origin seen while the app is open is
  // snapshotted, then scored against the real candles later.
  const [forecastLog, setForecastLog] = useState<ForecastRecord[]>([]);
  const forecastScopeRef = useRef<string | null>(null);
  // Cone self-calibration (per pair, device-local): the width
  // scale the scored record has earned so far, plus the newest
  // change for the feed to tell once.
  const [forecastCalib, setForecastCalib] =
    useState<ForecastCalib>(emptyCalib);
  const calibRef = useRef<ForecastCalib>(emptyCalib());
  const [calibEvent, setCalibEvent] = useState<CalibEvent | null>(null);
  useEffect(() => {
    if (!data) return;
    const pair = data.pair;
    if (forecastScopeRef.current !== pair) {
      forecastScopeRef.current = pair;
      setForecastLog(loadForecastLog(pair));
      const calib = loadForecastCalib(pair);
      calibRef.current = calib;
      setForecastCalib(calib);
      setCalibEvent(null);
      return;
    }
    const candles300 = data.candlesByTimeframe[300],
      last = candles300.at(-1);
    if (!last) return;
    const fc = chartForecast(
      candles300,
      FORECAST_BARS,
      data.bookImbalance,
      calibRef.current.scale,
    );
    if (!fc) return;
    setForecastLog((prev) => {
      const next = appendForecastRecord(
        prev,
        forecastRecordFrom(fc, last.close),
      );
      if (next !== prev) saveForecastLog(next, pair);
      return next;
    });
  }, [data]);
  const forecastScore = useMemo(
    () =>
      data
        ? scoreForecasts(forecastLog, data.candlesByTimeframe[300])
        : null,
    [forecastLog, data],
  );
  const forecastScoreLine = useMemo(() => {
    if (!forecastScore) return null;
    const line = forecastScoreText(forecastScore, forecastLog.length);
    if (!line) return null;
    return forecastCalib.scale !== 1
      ? `${line}（予測の幅は実績で学習中 ×${forecastCalib.scale.toFixed(2)}）`
      : line;
  }, [forecastScore, forecastLog.length, forecastCalib.scale]);
  // The learning step: each fresh batch of scored forecasts may
  // nudge the cone's width toward its target coverage. Runs off
  // the score memo; persists quietly, and only an actual change
  // becomes a feed event.
  useEffect(() => {
    if (!data || !forecastScore) return;
    const before = calibRef.current;
    const step = calibrationStep(forecastScore, before);
    if (step.calib === before) return;
    calibRef.current = step.calib;
    setForecastCalib(step.calib);
    saveForecastCalib(step.calib, data.pair);
    if (step.changed && forecastScore.coveragePct != null)
      setCalibEvent({
        at: Date.now(),
        scale: step.calib.scale,
        scored: forecastScore.scoredRecords,
        coveragePct: forecastScore.coveragePct,
        widened: step.calib.scale > before.scale,
      });
  }, [forecastScore, data]);
  const forecastAnswer = useMemo(
    () =>
      data
        ? latestAnswerCheck(forecastLog, data.candlesByTimeframe[300])
        : null,
    [forecastLog, data],
  );
  const forecastTouchLine = useMemo(() => {
    if (!data) return null;
    const candles = data.candlesByTimeframe[300];
    const nowMs = Date.now();
    for (let i = forecastLog.length - 1; i >= 0; i--) {
      const t = forecastTouchStateOf(forecastLog[i], candles, 300);
      if (!t) continue;
      if (t.phase === "pending") return touchStatusText(t, nowMs);
      if (t.phase === "touched" && nowMs < t.endsAt)
        return touchStatusText(t, nowMs);
      return null;
    }
    return null;
  }, [forecastLog, data]);
  const forecastInput = useMemo(
    () =>
      data
        ? {
            records: forecastLog,
            candles: data.candlesByTimeframe[300],
          }
        : null,
    [forecastLog, data],
  );
  const character = useAgentCharacter();
  const shareCard = useMemo(
    () =>
      data && forecastScore
        ? shareCardInputFor({
            pair: data.pair,
            candles: data.candlesByTimeframe[300],
            bookImbalance: data.bookImbalance,
            bandScale: forecastCalib.scale,
            score: forecastScore,
            character,
            agentName,
            at: Date.now(),
          })
        : null,
    [data, forecastScore, forecastCalib.scale, character, agentName],
  );
  return {
    forecastInput,
    calibEvent,
    forecastScoreLine,
    forecastTouchLine,
    forecastCalib,
    forecastAnswer,
    shareCard,
  };
}
