import BN from "bn.js";
import { toBase58 } from "@mysten/sui/utils";
import { AGGREGATOR_V3_CONFIG } from "@cetusprotocol/aggregator-sdk";
import { Transaction } from "@mysten/sui/transactions";
import { defaults, SUI, USDC, dayKey } from "../packages/shared/src/index.ts";
import { initialPortfolio } from "../packages/paper-trading/src/index.ts";
import { address } from "../packages/live-trading/src/policy.ts";
import type {
  BuildContext,
  LiveRequest,
  LivePolicy,
  WalletSnapshot,
  SimulationResponse,
} from "../packages/live-trading/src/types.ts";
export const CHAIN = toBase58(
  Uint8Array.from([0x35, 0x83, 0x4a, 0x8a, ...Array(28).fill(0)]),
);
export const DIGEST = toBase58(new Uint8Array(32));
export function fixture(): { context: BuildContext; request: LiveRequest } {
  const now = Date.now(),
    pkg = AGGREGATOR_V3_CONFIG.DEFAULT_PUBLISHED_AT.Mainnet;
  const shared = (id: string, mutable = false, type = "0x9::test::Config") => ({
    objectId: address(id),
    initialSharedVersion: "1",
    mutable,
    type,
  });
  const policy: LivePolicy = {
    allowedWallet: address("0x123"),
    aggregatorPackage: pkg,
    cetusPackage: pkg,
    globalConfig: shared(
      "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f",
    ),
    partner: shared("0x202"),
    clock: shared("0x6", false, "0x2::clock::Clock"),
    pool: shared("0x203", true, `0x9::pool::Pool<${USDC},${SUI}>`),
    gasBudgetMist: "30000000",
    minGasReserveMist: "100000000",
  };
  const wallet: WalletSnapshot = {
    address: policy.allowedWallet,
    chainIdentifier: CHAIN,
    observedAt: now,
    sui: "200000000",
    usdc: "100000000",
    gasPrice: "1000",
    coins: [
      {
        objectId: address("0x301"),
        version: "1",
        digest: DIGEST,
        coinType: SUI,
        balance: "200000000",
      },
      {
        objectId: address("0x302"),
        version: "1",
        digest: DIGEST,
        coinType: USDC,
        balance: "100000000",
      },
    ],
    objects: [
      policy.globalConfig,
      policy.partner,
      policy.clock,
      policy.pool,
    ].map((x) => ({ ...x })),
  };
  const quote = {
    id: "mock-quote",
    from: USDC,
    to: SUI,
    amountIn: "5000000",
    amountOut: "2500000000",
    minAmountOut: "2492500000",
    slippage: 0.003,
    referencePrice: 2,
    priceImpact: 0.001,
    liquid: true,
    createdAt: now,
    expiresAt: now + 15000,
    route: ["CETUS"],
    source: "mock",
  };
  const router = {
    quoteID: "mock-quote",
    amountIn: new BN(quote.amountIn),
    amountOut: new BN(quote.amountOut),
    byAmountIn: true,
    paths: [
      {
        id: policy.pool.objectId,
        direction: true,
        provider: "CETUS",
        from: USDC,
        target: SUI,
        feeRate: 0.0025,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        publishedAt: pkg,
      },
    ],
    insufficientLiquidity: false,
    deviationRatio: 0.001,
    packages: new Map([["aggregator_v3", pkg]]),
  };
  return {
    context: { policy, wallet, route: { quote, router } },
    request: {
      orderId: "mock-order",
      quote,
      risk: {
        side: "BUY",
        portfolio: initialPortfolio(now),
        runtime: {
          running: true,
          emergency: false,
          error: null,
          lastCandle: null,
        },
        settings: { ...defaults },
        price: 2,
        marketClosedAt: now,
        duplicate: false,
        pending: 0,
      },
    },
  };
}
export function simulation(bytes: Uint8Array): SimulationResponse {
  return {
    $kind: "Transaction",
    gasPaymentMocked: false,
    commandResults: undefined,
    Transaction: {
      digest: DIGEST,
      signatures: [],
      epoch: "1",
      timestampMs: null,
      checkpoint: null,
      status: { success: true, error: null },
      transaction: Transaction.from(bytes).getData(),
      balanceChanges: [
        { address: address("0x123"), coinType: USDC, amount: "-5000000" },
        { address: address("0x123"), coinType: SUI, amount: "2491500000" },
      ],
      events: undefined,
      objectTypes: undefined,
      bcs: undefined,
      effects: {
        bcs: null,
        version: 2,
        status: { success: true, error: null },
        gasUsed: {
          computationCost: "1000000",
          storageCost: "0",
          storageRebate: "0",
          nonRefundableStorageFee: "0",
        },
        transactionDigest: DIGEST,
        gasObject: null,
        eventsDigest: null,
        dependencies: [],
        lamportVersion: "1",
        changedObjects: [],
        unchangedConsensusObjects: [],
        auxiliaryDataDigest: null,
      },
    },
  };
}
