import type { CandleQuality } from "./reconstruction.ts";
import type {
  BookLevels,
  Candle,
  Timeframe,
} from "../../shared/src/index.ts";
import type { IndexerLatencyDrain } from "../../shared/src/operations.ts";
export type Frames = Record<number, Candle[]>;
export interface MarketStatus {
  diagnostics?: {
    bookObservation?: {
      timestamp: number;
      fetchedAt: number;
      bid: number;
      ask: number;
      spread: number;
      maxSpread: number;
    } | null;
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
  candles(timeframe: Timeframe, now?: number): Promise<Candle[]>;
  frames?(now?: number): Promise<Frames>;
  assertReady?(now: number): void;
  refreshForOrder?(): Promise<void>;
  status?(): MarketStatus;
  /** Display-only order-book imbalance in [-1, 1]; never an
   * input to trading or safety decisions. */
  bookImbalance?(now: number): number | null;
  /** Display-only top-of-book levels for the narration's wall
   * watch; never an input to trading or safety decisions. */
  bookLevels?(now: number): BookLevels | null;
  /** Drain the indexer latency telemetry recorded since the
   * previous drain — network durations (ms, per read class)
   * plus the TTL cache hits counted apart from them — for
   * persistence as display-grade telemetry; never an input
   * to trading or safety decisions. */
  latencySamples?(): IndexerLatencyDrain;
}
