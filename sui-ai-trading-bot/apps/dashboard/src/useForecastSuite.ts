import { useMemo } from "react";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import { emptyCalib } from "./forecastCalib.ts";
import { useAgentCharacter } from "./agentCharacter.ts";
import { shareCardInputFor } from "./shareCardInput.ts";

/** Presentation only. Legacy local state is read once by the migration bridge. */
export function useForecastSuite(data: BotSnapshot | null, agentName: string) {
  const character = useAgentCharacter();
  const state = data?.forecast;
  const shareCard = useMemo(
    () =>
      data && state
        ? shareCardInputFor({
            pair: data.pair,
            candles: data.candlesByTimeframe[300],
            forecast: state.latest,
            score: state.score,
            character,
            agentName,
            at: state.updatedAt,
          })
        : null,
    [data, state, character, agentName],
  );
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
    shareCard,
  };
}
