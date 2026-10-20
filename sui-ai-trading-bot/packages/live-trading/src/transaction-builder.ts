import {
  Transaction,
  type TransactionObjectArgument,
} from "@mysten/sui/transactions";
import BN from "bn.js";
import {
  AggregatorClient,
  Env,
  type RouterDataV3,
} from "@cetusprotocol/aggregator-sdk";
import { coin, SUI, bounded } from "../../shared/src/index.ts";
import {
  address,
  uint,
  requireLive,
  selectGas,
  validateRoute,
  hashBytes,
} from "./policy.ts";
import type {
  AggregatorApi,
  BuildContext,
  BuiltTransaction,
  LiveRequest,
  LiveRoute,
  LivePolicy,
} from "./types.ts";

export function baseTransaction(c: BuildContext) {
  const { policy: p, wallet: w, route } = c;
  const q = route.quote;
  const tx = new Transaction();
  tx.setSender(address(p.allowedWallet));
  tx.setGasOwner(address(p.allowedWallet));
  tx.setGasBudget(p.gasBudgetMist);
  tx.setGasPrice(w.gasPrice);
  tx.setGasPayment([
    selectGas(w, p, coin(q.from) === SUI ? uint(q.amountIn) : 0n),
  ]);
  // Supply reviewed shared references explicitly. No automatic object or gas selection during build.
  for (const object of [p.globalConfig, p.partner, p.clock, p.pool])
    tx.sharedObjectRef({ ...object, objectId: address(object.objectId) });
  let input: TransactionObjectArgument = tx.gas;
  if (coin(q.from) !== SUI) {
    const selected = w.coins.find(
      (x) =>
        coin(x.coinType) === coin(q.from) &&
        uint(x.balance) >= uint(q.amountIn),
    );
    requireLive(selected, "INPUT_COIN_FRAGMENTED_OR_MISSING");
    input = tx.objectRef(selected);
  }
  const [inputCoin] = tx.splitCoins(input, [tx.pure.u64(q.amountIn)]);
  return { tx, inputCoin };
}

/** Independently specified command/argument allowlist for the sole supported route shape. */
export function expectedTransaction(c: BuildContext) {
  const { tx, inputCoin } = baseTransaction(c);
  const {
    policy: p,
    route: { quote: q, router: r },
  } = c;
  const path = r.paths[0];
  const context = tx.moveCall({
    target: `${p.aggregatorPackage}::router::new_swap_context_v3`,
    typeArguments: [coin(q.from), coin(q.to)],
    arguments: [
      tx.pure.string(r.quoteID!),
      tx.pure.u64(q.amountIn),
      tx.pure.u64(q.amountIn),
      tx.pure.u64(q.amountOut),
      tx.pure.u64(Math.round(q.slippage * 1e6)),
      inputCoin,
      tx.pure.u32(0),
      tx.pure.address("0x0"),
    ],
  });
  tx.moveCall({
    target: `${p.cetusPackage}::cetus::swap`,
    typeArguments: path.direction
      ? [coin(q.from), coin(q.to)]
      : [coin(q.to), coin(q.from)],
    arguments: [
      context,
      tx.object(p.globalConfig.objectId),
      tx.object(p.pool.objectId),
      tx.object(p.partner.objectId),
      tx.pure.bool(path.direction),
      tx.pure.u64("18446744073709551615"),
      tx.object(p.clock.objectId),
    ],
  });
  const output = tx.moveCall({
    target: `${p.aggregatorPackage}::router::confirm_swap_v3`,
    typeArguments: [coin(q.to)],
    arguments: [context],
  });
  tx.transferObjects([output], address(p.allowedWallet));
  return tx;
}
export class TransactionBuilder {
  constructor(private aggregator: AggregatorApi) {}
  async build(c: BuildContext): Promise<BuiltTransaction> {
    validateRoute(c.route, c.policy);
    const { tx, inputCoin } = baseTransaction(c);
    // Defensive copy of BN/Map data: the external object is never allowed to mutate trusted policy.
    const router = cloneRouter(c.route.router);
    const output = await bounded(() =>
      this.aggregator.routerSwapWithMaxAmountIn({
        router,
        inputCoin,
        slippage: c.route.quote.slippage,
        txb: tx,
        maxAmountIn: new BN(c.route.quote.amountIn),
        partner: c.policy.partner.objectId,
      }),
    );
    tx.transferObjects([output], address(c.policy.allowedWallet));
    const bytes = await tx.build();
    return {
      bytes,
      hash: hashBytes(bytes),
      quote: structuredClone(c.route.quote),
    };
  }
}
export function cloneRouter(r: RouterDataV3): RouterDataV3 {
  return {
    ...r,
    amountIn: r.amountIn.clone(),
    amountOut: r.amountOut.clone(),
    paths: r.paths.map((x) => ({
      ...x,
      extendedDetails: x.extendedDetails
        ? structuredClone(x.extendedDetails)
        : undefined,
    })),
    packages: r.packages ? new Map(r.packages) : undefined,
  };
}
export class CetusLiveRouteSource {
  constructor(private aggregator: AggregatorApi) {}
  async fetch(request: LiveRequest, policy: LivePolicy): Promise<LiveRoute> {
    const q = structuredClone(request.quote);
    const router = await bounded(() =>
      this.aggregator.findRouters({
        from: coin(q.from),
        target: coin(q.to),
        amount: q.amountIn,
        byAmountIn: true,
        providers: ["CETUS"],
        includePools: [policy.pool.objectId],
        depth: 1,
        splitCount: 1,
        slippage: q.slippage,
      }),
    );
    requireLive(router, "NO_ROUTE");
    // An existing decision/quote cannot silently change under the caller. A changed quote needs a new preview.
    const result = { quote: q, router: cloneRouter(router) };
    validateRoute(result, policy);
    return result;
  }
}
export const createCetusLiveApi = (): AggregatorApi => {
  const client = new AggregatorClient({ env: Env.Mainnet, overlayFeeRate: 0 });
  return Object.freeze({
    findRouters: client.findRouters.bind(client),
    routerSwapWithMaxAmountIn: client.routerSwapWithMaxAmountIn.bind(client),
  });
};
