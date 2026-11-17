import { realTradeCapConfigSchema } from "../../../../packages/shared/src/index.ts";

export function realConfigFromEnv(env: NodeJS.ProcessEnv) {
  if (!env.REAL_DATABASE_PATH) throw Error("REAL_DATABASE_PATH_REQUIRED");
  if (env.DATABASE_PATH) throw Error("PAPER_DATABASE_PATH_FORBIDDEN_IN_REAL");
  const config = realTradeCapConfigSchema.parse({
    network: env.REAL_NETWORK ?? "testnet",
    balanceManagerId: env.REAL_BALANCE_MANAGER_ID,
    poolKey: env.REAL_POOL_KEY ?? "SUI_DBUSDC",
    tradeCapId: env.REAL_TRADE_CAP_ID,
    signerAddress: env.REAL_SIGNER_ADDRESS,
    sessionId: env.REAL_SESSION_ID,
    indexerUrl: env.REAL_DEEPBOOK_INDEXER_URL,
    graphqlUrl: env.REAL_SUI_GRAPHQL_URL,
    grpcUrl: env.REAL_SUI_GRPC_URL,
    maxOrderDbusdc:
      env.REAL_MAX_ORDER_DBUSDC === undefined
        ? undefined
        : Number(env.REAL_MAX_ORDER_DBUSDC),
    orderType: env.REAL_ORDER_TYPE,
    signingEnabled:
      env.REAL_SIGNING_ENABLED === undefined
        ? undefined
        : env.REAL_SIGNING_ENABLED === "true",
  });
  return { path: env.REAL_DATABASE_PATH, config };
}
