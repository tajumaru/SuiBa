import type { CandleQuality } from "./reconstruction.ts";
import type { Candle, Timeframe } from "../../shared/src/index.ts";
export type Frames = Record<number, Candle[]>;
export interface MarketStatus {
  diagnostics?: {
    indexerLagMs: number | null;
    indexedThrough: number;
    bidDepthUsdc: number | null;
    askDepthUsdc: number | null;
  };
  quality?: Record<number, CandleQuality>;
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
  bookSnapshot?(): import("./deepbook.ts").Book | null;
  candles(timeframe: Timeframe, now?: number): Promise<Candle[]>;
  frames?(now?: number): Promise<Frames>;
  assertReady?(now: number): void;
  refreshForOrder?(): Promise<void>;
  status?(): MarketStatus;
}
