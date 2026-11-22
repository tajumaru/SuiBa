export interface RealIdentity {
  network: "testnet";
  balanceManagerId: string;
  poolKey: "SUI_DBUSDC";
  tradeCapId: string;
  signerAddress: string;
  sessionId: string;
}

export interface RealEngineChecksRecord {
  identity: RealIdentity;
  recordedAt: number;
  risk: "ALLOWED" | "REJECTED" | "NOT_EVALUATED";
  profitGuard: "ALLOWED" | "BLOCKED" | "NOT_EVALUATED";
  market: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
}

export type RealEventKind =
  | "TX_EFFECTS"
  | "ORDER_PLACED"
  | "ORDER_FILLED"
  | "ORDER_CANCELLED"
  | "ASSET_MOVED"
  | "TRADE_FILL"
  | "TRADE_FEE";

export interface RealHistoryEvent {
  chain: "sui:testnet";
  checkpoint: string;
  digest: string;
  eventSequence: string;
  kind: RealEventKind;
  identity: RealIdentity;
  internalOrderId?: string;
  clientOrderId?: string;
  onchainOrderId?: string;
  asset?: "SUI" | "DBUSDC" | "DEEP";
  availableAtomicDelta?: string;
  orderLockedAtomicDelta?: string;
  settledUnclaimedAtomicDelta?: string;
  feeAtomic?: string;
  gasMist?: string;
  quantityAtomic?: string;
  remainingAtomic?: string;
  raw: unknown;
}

export interface HistoryPage {
  events: RealHistoryEvent[];
  nextCursor: string | null;
  checkpoint: string;
  checkpointHash: string;
}

export interface RealHistorySource {
  page(cursor: string | null): Promise<HistoryPage>;
  submissionStatus?(digest: string): Promise<"SUCCEEDED" | "FAILED" | null>;
}

export interface RealBalanceSnapshot {
  checkpoint: string;
  available: Record<"SUI" | "DBUSDC" | "DEEP", string>;
  orderLocked: Record<"SUI" | "DBUSDC" | "DEEP", string>;
  settledUnclaimed: Record<"SUI" | "DBUSDC" | "DEEP", string>;
  gasSuiMist: string;
}

export type RealOperation = "PLACE" | "CANCEL";
export type RealSubmissionState =
  "SUBMITTING" | "UNKNOWN" | "SUCCEEDED" | "FAILED";

export interface RealBuiltTransaction {
  bytes: Uint8Array;
  digest: string;
}

export interface RealEffects {
  digest: string;
  success: boolean;
  checkpoint: string;
  checkpointHash: string;
  events: RealHistoryEvent[];
  onchainOrderId?: string;
  errorCode?: string;
}
