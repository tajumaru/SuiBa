import type { Candle, Timeframe } from "../../shared/src/index.ts";
export type Frames = Record<number, Candle[]>;
export interface MarketStatus {
  configured: string;
  source: string | null;
  fallback: boolean;
  lastSuccessAt: number | null;
  latencyMs: number | null;
  reason: string | null;
  healthy: boolean;
  bookAt: number | null;
  bid: number | null;
  ask: number | null;
  spread: number | null;
}
export interface MarketDataProvider {
  candles(timeframe: Timeframe, now?: number): Promise<Candle[]>;
  frames?(now?: number): Promise<Frames>;
  assertReady?(now: number): void;
  status?(): MarketStatus;
}
