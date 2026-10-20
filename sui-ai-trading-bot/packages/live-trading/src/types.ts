import type { TransactionObjectArgument } from "@mysten/sui/transactions";
import type BN from "bn.js";
import type { SuiClientTypes } from "@mysten/sui/client";
import type {
  RouterDataV3,
  FindRouterParams,
  BuildRouterSwapParamsV3,
} from "@cetusprotocol/aggregator-sdk";
import type { RiskInput } from "../../risk-engine/src/index.ts";
import type { QuoteResult } from "../../shared/src/index.ts";
export type ObjectRef = { objectId: string; version: string; digest: string };
export interface OwnedCoin extends ObjectRef {
  coinType: string;
  balance: string;
}
export interface SharedInput {
  objectId: string;
  initialSharedVersion: string;
  mutable: boolean;
  type: string;
}
/** Server-reviewed manifest, never populated from an Aggregator response. No permissive defaults. */
export interface LivePolicy {
  allowedWallet: string;
  aggregatorPackage: string;
  cetusPackage: string;
  globalConfig: SharedInput;
  partner: SharedInput;
  clock: SharedInput;
  pool: SharedInput;
  gasBudgetMist: string;
  minGasReserveMist: string;
}
export interface WalletSnapshot {
  address: string;
  chainIdentifier: string;
  observedAt: number;
  sui: string;
  usdc: string;
  coins: OwnedCoin[];
  gasPrice: string;
  objects: SharedInput[];
}
export interface LiveRequest {
  orderId: string;
  quote: QuoteResult;
  risk: Omit<RiskInput, "quote" | "now" | "portfolio"> & {
    portfolio: RiskInput["portfolio"];
  };
}
export interface LiveRoute {
  quote: QuoteResult;
  router: RouterDataV3;
}
export interface BuildContext {
  policy: LivePolicy;
  wallet: WalletSnapshot;
  route: LiveRoute;
}
export interface BuiltTransaction {
  bytes: Uint8Array;
  hash: string;
  quote: QuoteResult;
}
export type Included = {
  effects: true;
  balanceChanges: true;
  transaction: true;
};
export type SimulationResponse =
  SuiClientTypes.SimulateTransactionResult<Included>;
export interface SimulationReport {
  transactionHash: string;
  simulatedAt: number;
  gasMist: string;
  receivedAtomic: string;
  inputAtomic: string;
  status: "SIMULATED_ONLY";
}
export interface PreviewResult {
  mode: "LIVE";
  status: "SIMULATED_ONLY";
  orderId: string;
  transactionHash: string;
  walletAddress: string;
  simulation: SimulationReport;
  signingEnabled: false;
  submissionEnabled: false;
}
/** Capability-limited dependencies deliberately exclude SDK signing/submission methods. */
export interface AggregatorApi {
  findRouters(request: FindRouterParams): Promise<RouterDataV3 | null>;
  routerSwapWithMaxAmountIn(
    params: BuildRouterSwapParamsV3 & { maxAmountIn: BN },
  ): Promise<TransactionObjectArgument>;
}
export interface SimulationApi {
  getChainIdentifier(): Promise<{ chainIdentifier: string }>;
  simulateTransaction(options: {
    transaction: Uint8Array;
    checksEnabled: true;
    doGasSelection: false;
    include: Included;
  }): Promise<SimulationResponse>;
}
export interface WalletReader {
  read(address: string, policy: LivePolicy): Promise<WalletSnapshot>;
}
export interface LiveState {
  running: false;
  emergency: boolean;
  reason: string | null;
  walletAddress: string | null;
  activeOrder: string | null;
}
export interface LiveStore {
  state(): LiveState;
  stop(reason: string): void;
  startPreview(wallet: string): void;
  reserve(orderId: string): void;
  complete(orderId: string, result: PreviewResult): void;
  fail(orderId: string, reason: string): void;
}
