import type { BotSnapshot } from "../../worker/src/engine.ts";
import { emptyCalib } from "./forecastCalib.ts";

/** Presentation only. Legacy local state is read once by the migration bridge. */
export function useForecastSuite(data: BotSnapshot | null) {
  const state = data?.forecast;
  return {
    forecastInput:
      data && state
        ? { records: state.records, candles: data.candlesByTimeframe[300] }
        : null,
    calibEvent: state?.events ?? [],
    forecastScoreLine: state?.scoreLine ?? null,
    forecastTouchLine: state?.touchLine ?? null,
    forecastCalib: state?.calib ?? emptyCalib(),
    forecastAnswer: state?.answer ?? null,
  };
}
