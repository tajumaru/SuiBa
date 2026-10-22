import type { ApiFailure } from "./http-errors.ts";
import type { PaperRecoveryProof } from "./paper-recovery.ts";
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
}
export interface OperationState {
  lastFetchAttemptAt?: number | null;
  lastFetchSuccessAt?: number | null;
  lastTransportSuccessAt?: number | null;
  lastAnalysisAt?: number | null;
  fetchStartedAt?: number | null;
  lastFetchDurationMs?: number | null;
  nextFetchAt?: number | null;
  nextFetchReason?: string | null;

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
