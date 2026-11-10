import type { ApiFailure } from "./http-errors.ts";
import type {
  EpisodeSummary,
  PaperRecoveryProof,
} from "./paper-recovery.ts";
export interface CandidateAudit {
  id: string;
  orderId: string;
  timestamp: number;
  createdAt: number;
  side: "BUY" | "SELL";
  requestedInputAtomic: string;
  quantityAtomic: string | null;
  quotePriceUsdc: string | null;
  quoteExpiresAt: number | null;
  reverseQuoteExpiresAt?: number | null;
  projectedSaleFeeUsdc?: string | null;
  projectedSaleGasUsdc?: string | null;
  acquisitionCostUsdc: string | null;
  expectedSaleUsdc: string | null;
  saleModel: "CURRENT_QUOTE" | "PROJECTED_TARGET" | null;
  dexFeeUsdc: string | null;
  gasUsdc: string | null;
  additionalFeeUsdc: string | null;
  buyGasUsdc: string | null;
  netProfitUsdc: string | null;
  minProfitUsdc: string;
  minProfitPct: string;
  profitGuard: {
    evaluated: boolean;
    allowed: boolean | null;
    reason: string | null;
  };
  risk: { status: "NOT_EVALUATED" | "ALLOWED" | "REJECTED"; reasons: string[] };
  finalAction: "PENDING" | "BUY" | "SELL" | "WAIT" | "SAFE_STOP";
  reasons: string[];
}
export interface MarketStallDetails {
  evaluatedAt: number;
  reasonDetail:
    | "CANDLE_STALE"
    | "FETCH_DEADLINE_EXCEEDED"
    | "FETCH_SUCCESS_STALE"
    | "NO_VALID_MARKET_DATA";
  candleAgeSeconds: number | null;
  lastFetchSuccessAgeSeconds: number | null;
  lastValidatedMarketAgeSeconds: number | null;
  fetching: boolean;
  fetchStartedAt: number | null;
  fetchElapsedMs: number | null;
  lastFetchDurationMs: number | null;
  nextFetchAt: number | null;
  latestClosedAt: number | null;
}
export interface OperationEvent {
  timestamp: number;
  kind: "WAIT" | "ERROR" | "ANOMALY" | "STOP" | "CONTROL" | "BOOT" | "API";
  code: string;
  fatal?: boolean;
  details?: MarketStallDetails;
  apiFailure?: ApiFailure;
  recoveryProof?: PaperRecoveryProof;
  /** Set on the event that closes a recovery episode (recovered,
   * hard stop, or boot): what failed, how often, for how long. */
  episode?: EpisodeSummary;
}
/** DeepBook Indexer read classes whose caller-visible latency
 * is accumulated as display-grade telemetry. */
export type IndexerLatencyKind = "candles" | "book" | "status" | "other";
export const indexerLatencyKinds: readonly IndexerLatencyKind[] = [
  "candles",
  "book",
  "status",
  "other",
];
export interface IndexerLatencyBucket {
  /** Total network samples recorded into this aggregate.
   * TTL cache hits are counted apart in `cached` and never
   * enter this count, `maxMs` or `recent`: a hit performs no
   * fetch, so its near-zero duration would corrupt the
   * network latency distribution. */
  count: number;
  /** Largest network sample ever recorded (ms). */
  maxMs: number;
  /** Bounded ring of the most recent network samples (ms),
   * oldest first; the median is computed from this window. */
  recent: number[];
  /** Reads served by the TTL cache (no network fetch).
   * Absent in aggregates persisted before the split. */
  cached?: number;
}
/** One drain of the provider's pending indexer latency
 * telemetry: network durations to fold into the distribution,
 * plus the TTL cache hits to count apart from it. */
export interface IndexerLatencyDrain {
  samples: Record<IndexerLatencyKind, number[]>;
  cached: Record<IndexerLatencyKind, number>;
}
/** Persisted in operation_state: bounded by construction (four
 * scalar counters plus a capped ring per kind), so it survives
 * restarts without growing the runtime row without limit. */
export type IndexerLatencyAggregate = Record<
  IndexerLatencyKind,
  IndexerLatencyBucket
>;
export interface OperationState {
  lastFetchAttemptAt?: number | null;
  lastFetchSuccessAt?: number | null;
  lastTransportSuccessAt?: number | null;
  lastAnalysisAt?: number | null;
  fetchStartedAt?: number | null;
  lastFetchDurationMs?: number | null;
  nextFetchAt?: number | null;
  nextFetchReason?: string | null;
  indexerLatency?: IndexerLatencyAggregate | null;

  observedSince: number;
  processStartedAt: number;
  runningMs: number;
  accountedAt: number;
  active: boolean;
  lastHeartbeatAt: number;
  lastMarketAt: number | null;
  lastMarketClosedAt: number | null;
  lastQuoteAt: number | null;
  lastQuoteExpiresAt: number | null;
  lastTradeAt: number | null;
  lastHealthyAt: number | null;
  apiErrors: number;
  consecutiveErrors: number;
}
