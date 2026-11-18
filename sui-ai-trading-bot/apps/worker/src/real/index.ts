import { realConfigFromEnv } from "./config.ts";
import { RealTradeCapDatabase } from "./database.ts";
import { IndexerGraphqlHistorySource } from "./history-source.ts";
import { RealReconciler } from "./reconciler.ts";
import { createDeepBookReadOnly } from "./read-only.ts";
import type { RealHistorySource, RealIdentity } from "./types.ts";

export async function reconcileRealReadOnlyOnce(input: {
  db: RealTradeCapDatabase;
  identity: RealIdentity;
  source: RealHistorySource;
  snapshot(): Promise<{ openOrderIds: unknown[] }>;
}) {
  const result = await new RealReconciler(
    input.db,
    input.identity,
    input.source,
  ).reconcileAllPages();
  const state = await input.snapshot();
  return { ...result, openOrders: state.openOrderIds.length };
}

export async function startRealReadOnly(env: NodeJS.ProcessEnv = process.env) {
  const { path, config } = realConfigFromEnv(env);
  const identity = {
    network: config.network,
    balanceManagerId: config.balanceManagerId,
    poolKey: config.poolKey,
    tradeCapId: config.tradeCapId,
    signerAddress: config.signerAddress,
    sessionId: config.sessionId,
  } as const;
  const db = new RealTradeCapDatabase(path);
  db.registerIdentity(identity);
  const source = new IndexerGraphqlHistorySource(
    config.indexerUrl,
    config.graphqlUrl,
    identity,
    db.checkpoint(),
  );
  const reader = createDeepBookReadOnly(config, config.grpcUrl);
  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcileRealReadOnlyOnce({
        db,
        identity,
        source,
        snapshot: () => reader.snapshot(),
      });
      console.info(
        JSON.stringify({
          event: "REAL_READ_ONLY_RECONCILED",
          ...result,
          signingEnabled: false,
          network: "testnet",
          openOrders: result.openOrders,
        }),
      );
    } finally {
      running = false;
    }
  };
  await reconcile();
  await new Promise<void>((resolve) => {
    const timer = setInterval(
      () =>
        void reconcile().catch(() => {
          console.error("REAL_READ_ONLY_RECONCILIATION_FAILED");
        }),
      60_000,
    );
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => {
        clearInterval(timer);
        db.close();
        resolve();
      });
  });
}
