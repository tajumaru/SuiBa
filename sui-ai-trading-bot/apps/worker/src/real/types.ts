export interface RealIdentity {
  network: "testnet";
  balanceManagerId: string;
  poolKey: "SUI_DBUSDC";
  tradeCapId: string;
  signerAddress: string;
  sessionId: string;
}

export type RealEventKind =
  | "TX_EFFECTS"
  | "ORDER_PLACED"
  | "ORDER_FILLED"
  | "ORDER_CANCELLED"
  | "ASSET_MOVED";

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
}

export interface RealBalanceSnapshot {
  checkpoint: string;
  available: Record<"SUI" | "DBUSDC" | "DEEP", string>;
  orderLocked: Record<"SUI" | "DBUSDC" | "DEEP", string>;
  settledUnclaimed: Record<"SUI" | "DBUSDC" | "DEEP", string>;
  gasSuiMist: string;
}
