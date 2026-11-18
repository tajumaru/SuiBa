import { deepbook, OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";
import { Transaction } from "@mysten/sui/transactions";
import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { RealTradeCapConfig } from "../../../../packages/shared/src/index.ts";
import type {
  RealCancelIntent,
  RealExecutionIntent,
  RealTransactionBuilder,
} from "./execution.ts";

interface LimitIntent {
  price: number;
  quantity: number;
  expiresAt: number;
}
const limit = (value: unknown): LimitIntent => {
  const x = value as Partial<LimitIntent>;
  if (!(
    Number.isFinite(x.price) &&
    Number.isFinite(x.quantity) &&
    Number.isFinite(x.expiresAt)
  ))
    throw Error("REAL_LIMIT_INTENT_INVALID");
  return x as LimitIntent;
};

/** DeepBook v3 testnet PTB builder. It builds once; the exact returned bytes are
 * persisted by RealTradeCapExecutor before the REAL-only Bot signer sees them. */
export function createDeepBookTransactionBuilder(
  client: SuiGrpcClient,
  config: RealTradeCapConfig,
): RealTransactionBuilder {
  const extended = client.$extend(
    deepbook({
      address: config.signerAddress,
      balanceManagers: {
        PHASE1: {
          address: config.balanceManagerId,
          tradeCap: config.tradeCapId,
        },
      },
    }),
  );
  const finish = async (tx: Transaction) => {
    tx.setSender(config.signerAddress);
    const bytes = await tx.build({ client });
    return { bytes, digest: await tx.getDigest({ client }) };
  };
  return {
    async place(input: RealExecutionIntent) {
      if (config.orderType === "MARKET")
        throw Error("REAL_ORDER_TYPE_UNSUPPORTED");
      const order = limit(input.intent);
      const tx = new Transaction();
      tx.add(
        extended.deepbook.deepBook.placeLimitOrder({
          poolKey: config.poolKey,
          balanceManagerKey: "PHASE1",
          clientOrderId: input.clientOrderId,
          price: order.price,
          quantity: order.quantity,
          isBid: input.side === "BUY",
          expiration: order.expiresAt,
          orderType: OrderType.IMMEDIATE_OR_CANCEL,
          selfMatchingOption: SelfMatchingOptions.CANCEL_TAKER,
          payWithDeep: true,
        }),
      );
      return finish(tx);
    },
    async cancel(input: RealCancelIntent) {
      const tx = new Transaction();
      tx.add(
        extended.deepbook.deepBook.cancelOrder(
          config.poolKey,
          "PHASE1",
          input.targetOrderId,
        ),
      );
      return finish(tx);
    },
  };
}
