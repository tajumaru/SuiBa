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
export interface OperationEvent {
  timestamp: number;
  kind: "WAIT" | "ERROR" | "ANOMALY" | "STOP" | "CONTROL" | "BOOT";
  code: string;
  fatal?: boolean;
}
export interface OperationState {
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
