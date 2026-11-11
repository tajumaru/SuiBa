/**
 * The forecast share card's input assembly: everything the chart
 * layer needs eagerly to know WHETHER a card can be offered. The
 * renderer itself (SVG template + PNG conversion) lives in
 * shareCard.ts and loads on demand when the reader actually taps
 * the share button — see PriceChart.
 */

import type { Candle } from "../../../packages/shared/src/index.ts";
import {
  FORECAST_BARS,
  chartForecast,
  type ChartForecast,
} from "./chartForecast.ts";
import type { ForecastScore } from "./forecastLog.ts";
import { artworkFor } from "./AgentHeaderAvatar.tsx";
import { agentDisplayName } from "./agentName.ts";
import type { AgentCharacter } from "./agentCharacter.ts";

export interface ShareCardInput {
  /** "SUI / USDC" style pair label. */
  pairLabel: string;
  /** The most recent 5-minute candles (the assembly keeps 48). */
  candles: Candle[];
  forecast: ChartForecast;
  score: ForecastScore;
  /** The character's display name (custom name or its default). */
  displayName: string;
  /** Bundled asset URL of the character's normal artwork; the
   * browser layer resolves it to a data URL for the SVG. */
  characterImageSrc: string;
  /** Card creation time, epoch ms. */
  at: number;
}

/** Assemble the card input from the dashboard's live state, or
 * null while no forecast can be drawn. */
export function shareCardInputFor(args: {
  pair: string;
  candles: Candle[];
  bookImbalance?: number | null;
  /** Learned cone-width scale, so the card's cone matches the
   * chart's. */
  bandScale?: number;
  score: ForecastScore;
  character: AgentCharacter;
  agentName: string;
  at: number;
}): ShareCardInput | null {
  if (args.candles.length < 2) return null;
  const forecast = chartForecast(
    args.candles,
    FORECAST_BARS,
    args.bookImbalance ?? null,
    args.bandScale ?? 1,
  );
  if (!forecast) return null;
  return {
    pairLabel: args.pair === "WAL_USDC" ? "WAL / USDC" : "SUI / USDC",
    candles: args.candles.slice(-48),
    forecast,
    score: args.score,
    displayName: agentDisplayName(args.agentName, args.character),
    characterImageSrc: artworkFor(args.character, "normal", false).main,
    at: args.at,
  };
}
