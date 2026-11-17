import { deepbook } from "@mysten/deepbook-v3";
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import type { RealTradeCapConfig } from "../../../../packages/shared/src/index.ts";

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
        client.deepbook.account(config.poolKey, "PHASE1"),
        client.deepbook.poolTradeParams(config.poolKey),
      ]);
      // SDK 2.8.0 returns normalized values. Do not divide these again.
      const gasResponse = await fetch(config.graphqlUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query GasBalance($address: SuiAddress!) { address(address: $address) {
            balance(type: "0x2::sui::SUI") { totalBalance }
          } }`,
          variables: { address: config.signerAddress },
        }),
      });
      if (!gasResponse.ok)
        throw Error(`REAL_GRAPHQL_HTTP_${gasResponse.status}`);
      const gas = (await gasResponse.json()) as {
        data?: { address?: { balance?: { totalBalance?: string } } };
      };
      return {
        balances: { SUI: suiBalance, DBUSDC: dbusdcBalance, DEEP: deepBalance },
        openOrderIds,
        orderDetails,
        book,
        locked,
        settledUnclaimed: account,
        tradeParams,
        botGasSuiMist: gas.data?.address?.balance?.totalBalance ?? "0",
      };
    },
  };
}
