import { deepbook } from "@mysten/deepbook-v3";
import type { AccountInfo } from "@mysten/deepbook-v3";
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import type { RealTradeCapConfig } from "../../../../packages/shared/src/index.ts";

type AccountReader = {
  accountExists(poolKey: string, managerKey: string): Promise<boolean>;
  account(poolKey: string, managerKey: string): Promise<AccountInfo>;
};

type Asset = "SUI" | "DBUSDC" | "DEEP";
type PoolRelativeBalances = { base: number; quote: number; deep: number };

export const GAS_BALANCE_QUERY = `query GasBalance($address: SuiAddress!) { address(address: $address) {
  balance(coinType: "0x2::sui::SUI") { totalBalance }
} }`;

export function graphqlGasBalance(payload: unknown): string {
  if (typeof payload !== "object" || payload === null)
    throw Error("REAL_GRAPHQL_DATA_MISSING");
  const result = payload as {
    data?: { address?: { balance?: { totalBalance?: unknown } } };
    errors?: unknown[];
  };
  if (result.errors?.length) throw Error("REAL_GRAPHQL_ERRORS");
  if (!result.data) throw Error("REAL_GRAPHQL_DATA_MISSING");
  const total = result.data.address?.balance?.totalBalance;
  if (typeof total !== "string" || !/^\d+$/.test(total))
    throw Error("REAL_GRAPHQL_GAS_BALANCE_INVALID");
  return total;
}

const poolAssets = (poolKey: string) => {
  if (poolKey === "SUI_DBUSDC")
    return { base: "SUI", quote: "DBUSDC", deep: "DEEP" } as const;
  throw Error("REAL_POOL_ASSET_MAPPING_UNSUPPORTED");
};

export function remapPoolBalances(
  poolKey: string,
  values: PoolRelativeBalances,
): Record<Asset, number> {
  const assets = poolAssets(poolKey);
  return {
    [assets.base]: values.base,
    [assets.quote]: values.quote,
    [assets.deep]: values.deep,
  } as Record<Asset, number>;
}

export function unwrapManagerBalance(value: unknown): number {
  if (
    typeof value !== "object" ||
    value === null ||
    !("balance" in value) ||
    typeof value.balance !== "number"
  )
    throw Error("REAL_BALANCE_INVALID");
  return value.balance;
}

const EMPTY_ACCOUNT: AccountInfo = {
  epoch: "0",
  open_orders: { contents: [] },
  taker_volume: 0,
  maker_volume: 0,
  active_stake: 0,
  inactive_stake: 0,
  created_proposal: false,
  voted_proposal: null,
  unclaimed_rebates: { base: 0, quote: 0, deep: 0 },
  settled_balances: { base: 0, quote: 0, deep: 0 },
  owed_balances: { base: 0, quote: 0, deep: 0 },
};

export async function resolveAccount(
  reader: AccountReader,
  poolKey: string,
): Promise<AccountInfo> {
  if (!(await reader.accountExists(poolKey, "PHASE1"))) return EMPTY_ACCOUNT;
  return reader.account(poolKey, "PHASE1");
}

export function createDeepBookReadOnly(
  config: RealTradeCapConfig,
  grpcUrl: string,
) {
  const sui = new SuiGrpcClient({
    network: "testnet",
    transport: new GrpcWebFetchTransport({ baseUrl: grpcUrl }),
  });
  const client = sui.$extend(
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
  return {
    async snapshot() {
      const [
        suiBalance,
        dbusdcBalance,
        deepBalance,
        openOrderIds,
        orderDetails,
        book,
        locked,
        account,
        tradeParams,
      ] = await Promise.all([
        client.deepbook.checkManagerBalance("PHASE1", "SUI"),
        client.deepbook.checkManagerBalance("PHASE1", "DBUSDC"),
        client.deepbook.checkManagerBalance("PHASE1", "DEEP"),
        client.deepbook.accountOpenOrders(config.poolKey, "PHASE1"),
        client.deepbook.getAccountOrderDetails(config.poolKey, "PHASE1"),
        client.deepbook.getLevel2TicksFromMid(config.poolKey, 50),
        client.deepbook.lockedBalance(config.poolKey, "PHASE1"),
        resolveAccount(client.deepbook, config.poolKey),
        // Fee discovery is fail-closed for entries in the engine, but must not
        // make the whole balance/open-order snapshot unavailable: exits have a
        // separately audited last-known/assumption fallback.
        client.deepbook.poolTradeParams(config.poolKey).catch(() => null),
      ]);
      // SDK 2.8.0 returns normalized values. Do not divide these again.
      const gasResponse = await fetch(config.graphqlUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: GAS_BALANCE_QUERY,
          variables: { address: config.signerAddress },
        }),
      });
      if (!gasResponse.ok)
        throw Error(`REAL_GRAPHQL_HTTP_${gasResponse.status}`);
      const botGasSuiMist = graphqlGasBalance(await gasResponse.json());
      return {
        balances: {
          SUI: unwrapManagerBalance(suiBalance),
          DBUSDC: unwrapManagerBalance(dbusdcBalance),
          DEEP: unwrapManagerBalance(deepBalance),
        },
        openOrderIds,
        orderDetails,
        book,
        locked: remapPoolBalances(config.poolKey, locked),
        settledUnclaimed: remapPoolBalances(
          config.poolKey,
          account.settled_balances,
        ),
        owedBalances: remapPoolBalances(config.poolKey, account.owed_balances),
        accountInfo: account,
        tradeParams,
        botGasSuiMist,
      };
    },
  };
}
