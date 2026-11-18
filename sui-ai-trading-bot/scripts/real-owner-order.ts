import "dotenv/config";

import { createHash } from "node:crypto";
import { deepbook, OrderType, SelfMatchingOptions } from "@mysten/deepbook-v3";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import Decimal from "decimal.js";
import { realConfigFromEnv } from "../apps/worker/src/real/config.ts";
import { createDeepBookReadOnly } from "../apps/worker/src/real/read-only.ts";
import { atomic, PHASE1_DECIMALS } from "./real-resume.ts";
import { isMainModule } from "./is-main-module.ts";

export type OwnerOrderSide = "BUY" | "SELL";

export interface OwnerOrderPlan {
  side: OwnerOrderSide;
  price: number;
  quantity: number;
  totalValue: number;
  bestBid: number;
  bestAsk: number;
  clientOrderId: string;
  sdkClientOrderId: string;
}

interface SnapshotOrder {
  balance_manager_id?: string;
  order_id: string;
  client_order_id: string;
  quantity: string;
  filled_quantity: string;
}

interface OwnerOrderSnapshot {
  book: { bid_prices: number[]; ask_prices: number[] };
  orderDetails: SnapshotOrder[];
}

export interface OwnerOrderDependencies {
  snapshot(): Promise<OwnerOrderSnapshot>;
  place(plan: OwnerOrderPlan): Promise<{ orderId: string; digest: string }>;
  cancel(orderId: string): Promise<string>;
  output(value: unknown): void;
}

const CLIENT_ID_PREFIX = "phase1-s2";
const CLIENT_ID_MAGIC = createHash("sha256")
  .update(CLIENT_ID_PREFIX)
  .digest()
  .readUInt32BE(0);

const flagValue = (argv: string[], flag: string) => {
  const exact = argv.indexOf(flag);
  if (exact >= 0) return argv[exact + 1];
  return argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
};

const decimal = (value: string | undefined, error: string) => {
  if (!value || !/^\d+(\.\d+)?$/.test(value)) throw Error(error);
  const parsed = new Decimal(value);
  if (!parsed.isPositive()) throw Error(error);
  return parsed;
};

export function phase1S2ClientOrderId(
  side: OwnerOrderSide,
  price: string,
  quantity: string,
) {
  const payload = `${CLIENT_ID_PREFIX}|${side}|${atomic(price, PHASE1_DECIMALS.DBUSDC)}|${atomic(quantity, PHASE1_DECIMALS.SUI)}`;
  const suffix = createHash("sha256").update(payload).digest().readUInt32BE(0);
  const numeric = (BigInt(CLIENT_ID_MAGIC) << 32n) | BigInt(suffix);
  return {
    label: `${CLIENT_ID_PREFIX}:${numeric}`,
    numeric: numeric.toString(),
  };
}

const displayClientOrderId = (value: string) => {
  const numeric = BigInt(value);
  return Number(numeric >> 32n) === CLIENT_ID_MAGIC
    ? `${CLIENT_ID_PREFIX}:${value}`
    : value;
};

const renderOrders = (orders: SnapshotOrder[]) =>
  orders.map((order) => {
    const encoded = BigInt(order.order_id);
    const isBid = encoded >> 127n === 0n;
    const rawPrice = (encoded >> 64n) & ((1n << 63n) - 1n);
    const remaining = BigInt(order.quantity) - BigInt(order.filled_quantity);
    return {
      orderId: order.order_id,
      clientOrderId: displayClientOrderId(order.client_order_id),
      side: isBid ? "BUY" : "SELL",
      price: new Decimal(rawPrice.toString())
        .div(10 ** PHASE1_DECIMALS.DBUSDC)
        .toNumber(),
      quantity: new Decimal(remaining.toString())
        .div(10 ** PHASE1_DECIMALS.SUI)
        .toNumber(),
    };
  });

export async function runOwnerOrder(
  env: NodeJS.ProcessEnv,
  argv: string[],
  dependencies?: OwnerOrderDependencies,
) {
  const list = argv.includes("--list");
  const cancelId = flagValue(argv, "--cancel");
  const execute = argv.includes("--execute");
  const modes = Number(list) + Number(cancelId !== undefined) + Number(execute);
  if (modes > 1) throw Error("REAL_OWNER_ORDER_MODE_CONFLICT");

  let runtime = dependencies;
  if (!runtime) runtime = createRuntime(env, execute || cancelId !== undefined);

  if (list) {
    const snapshot = await runtime.snapshot();
    const orders = renderOrders(snapshot.orderDetails);
    runtime.output({ mode: "LIST", orders });
    return { orders };
  }

  if (cancelId !== undefined) {
    if (!/^\d+$/.test(cancelId)) throw Error("REAL_OWNER_ORDER_ID_INVALID");
    const digest = await runtime.cancel(cancelId);
    runtime.output({ mode: "CANCEL", orderId: cancelId, digest });
    return { orderId: cancelId, digest };
  }

  const side = flagValue(argv, "--side");
  if (side !== "BUY" && side !== "SELL")
    throw Error("REAL_OWNER_ORDER_SIDE_REQUIRED");
  const priceText = flagValue(argv, "--price");
  const quantityText = flagValue(argv, "--quantity");
  const price = decimal(priceText, "REAL_OWNER_ORDER_PRICE_INVALID");
  const quantity = decimal(quantityText, "REAL_OWNER_ORDER_QUANTITY_INVALID");
  atomic(priceText!, PHASE1_DECIMALS.DBUSDC);
  atomic(quantityText!, PHASE1_DECIMALS.SUI);
  const total = price.mul(quantity);
  if (quantity.gt(1)) throw Error("REAL_OWNER_ORDER_QUANTITY_CAP_EXCEEDED");
  if (total.gt(1)) throw Error("REAL_OWNER_ORDER_VALUE_CAP_EXCEEDED");

  let snapshot: OwnerOrderSnapshot;
  try {
    snapshot = await runtime.snapshot();
  } catch (cause) {
    throw new Error("REAL_OWNER_ORDER_BOOK_READ_FAILED", { cause });
  }
  const bestBid = snapshot.book.bid_prices[0];
  const bestAsk = snapshot.book.ask_prices[0];
  if (!(bestBid > 0) || !(bestAsk > 0))
    throw Error("REAL_OWNER_ORDER_BOOK_READ_FAILED");
  if (side === "BUY" && price.gte(new Decimal(bestAsk).mul(0.9)))
    throw Error("REAL_OWNER_ORDER_BUY_NOT_RESTING");
  if (side === "SELL" && price.lte(new Decimal(bestBid).mul(1.1)))
    throw Error("REAL_OWNER_ORDER_SELL_NOT_RESTING");

  const clientId = phase1S2ClientOrderId(side, priceText!, quantityText!);
  const plan: OwnerOrderPlan = {
    side,
    price: price.toNumber(),
    quantity: quantity.toNumber(),
    totalValue: total.toNumber(),
    bestBid,
    bestAsk,
    clientOrderId: clientId.label,
    sdkClientOrderId: clientId.numeric,
  };
  runtime.output({ mode: execute ? "EXECUTE" : "DRY_RUN", ...plan });
  if (!execute) return { plan, orderId: null, digest: null };
  const result = await runtime.place(plan);
  runtime.output({ state: "SENT", ...result });
  return { plan, ...result };
}

function createRuntime(
  env: NodeJS.ProcessEnv,
  signingRequired: boolean,
): OwnerOrderDependencies {
  const { config } = realConfigFromEnv(env);
  const key = env.REAL_OWNER_PRIVATE_KEY;
  if (signingRequired && !key) throw Error("REAL_OWNER_PRIVATE_KEY_REQUIRED");
  const signer = key ? Ed25519Keypair.fromSecretKey(key) : null;
  const address = signer?.toSuiAddress() ?? config.signerAddress;
  const client = new SuiGrpcClient({
    network: "testnet",
    transport: new GrpcWebFetchTransport({ baseUrl: config.grpcUrl }),
  });
  const sdk = client.$extend(
    deepbook({
      address,
      balanceManagers: { PHASE1: { address: config.balanceManagerId } },
    }),
  );
  const readOnly = createDeepBookReadOnly(
    { ...config, signerAddress: address },
    config.grpcUrl,
  );
  const send = async (tx: Transaction) => {
    if (!signer) throw Error("REAL_OWNER_PRIVATE_KEY_REQUIRED");
    tx.setSender(address);
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer,
      include: { events: true },
    });
    const executed = result.Transaction ?? result.FailedTransaction;
    if (!result.Transaction) throw Error("REAL_OWNER_ORDER_TRANSACTION_FAILED");
    return executed;
  };
  return {
    snapshot: readOnly.snapshot,
    async place(plan) {
      const tx = new Transaction();
      tx.add(
        sdk.deepbook.deepBook.placeLimitOrder({
          poolKey: config.poolKey,
          balanceManagerKey: "PHASE1",
          clientOrderId: plan.sdkClientOrderId,
          price: plan.price,
          quantity: plan.quantity,
          isBid: plan.side === "BUY",
          orderType: OrderType.POST_ONLY,
          selfMatchingOption: SelfMatchingOptions.CANCEL_TAKER,
          payWithDeep: true,
        }),
      );
      const result = await send(tx);
      const placed = result.events.find(
        (event) =>
          event.eventType.endsWith("::order_info::OrderPlaced") &&
          String(event.json?.clientOrderId ?? event.json?.client_order_id) ===
            plan.sdkClientOrderId,
      );
      const orderId = placed?.json?.orderId ?? placed?.json?.order_id;
      if (typeof orderId !== "string")
        throw Error("REAL_OWNER_ORDER_ID_MISSING");
      return { orderId, digest: result.digest };
    },
    async cancel(orderId) {
      const tx = new Transaction();
      tx.add(
        sdk.deepbook.deepBook.cancelOrder(config.poolKey, "PHASE1", orderId),
      );
      return (await send(tx)).digest;
    },
    output: console.info,
  };
}

if (isMainModule(import.meta.url, process.argv[1]))
  await runOwnerOrder(process.env, process.argv.slice(2));
