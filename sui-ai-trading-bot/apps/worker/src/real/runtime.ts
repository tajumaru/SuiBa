import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import { realConfigFromEnv } from "./config.ts";
import { RealTradeCapDatabase } from "./database.ts";
import { createDeepBookTransactionBuilder } from "./deepbook-execution.ts";
import { RealTradeCapExecutor } from "./execution.ts";
import { RealTradeCapExecutionAdapter } from "./adapter.ts";
import { tradeCapValid } from "./cap-valid.ts";
import { IndexerGraphqlHistorySource } from "./history-source.ts";
import { cacheRealBalances } from "./display-balances.ts";
import { createDeepBookReadOnly } from "./read-only.ts";
import type { RealEffects, RealIdentity } from "./types.ts";
import { RealBookParamsCache } from "./book-params-cache.ts";
import { RealReconciler } from "./reconciler.ts";
import { RealFeeCache } from "./fee-cache.ts";

type LiveProbeName = "snapshot" | "cap" | "history";

const reason = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function runRealLiveProbe(input: {
  snapshot(): Promise<unknown>;
  capValid(): Promise<boolean>;
  historyPage(): Promise<unknown>;
}) {
  const probe = async (name: LiveProbeName, read: () => Promise<unknown>) => {
    try {
      await read();
    } catch (error) {
      console.error(
        `REAL_LIVE_PROBE_FAILED probe=${name} reason=${reason(error)}`,
      );
      throw Error(`REAL_LIVE_PROBE_FAILED probe=${name}`);
    }
  };
  await probe("snapshot", input.snapshot);
  await probe("cap", async () => {
    if (!(await input.capValid())) throw Error("TRADE_CAP_INVALID");
  });
  await probe("history", input.historyPage);
  console.info("REAL live probe passed: snapshot, cap, history");
}

export async function continueAfterRealLiveProbe<T>(
  runtime: { liveProbe(): Promise<void> } | undefined,
  continueStartup: () => T,
) {
  await runtime?.liveProbe();
  return continueStartup();
}

export function startRealTradeCapReconciliation(reconciler: RealReconciler) {
  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      const { pages, events } = await reconciler.reconcileAllPages();
      console.info(JSON.stringify({
        event: "REAL_TRADECAP_RECONCILED",
        pages,
        events,
      }));
    } catch {
      console.error("REAL_TRADECAP_RECONCILIATION_FAILED");
    } finally {
      running = false;
    }
  };

  void reconcile();
  const timer = setInterval(() => void reconcile(), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Constructs the REAL-only execution boundary. No PAPER key or sender is
 * accepted here. The persisted control row remains halted across restart until
 * the complete resume gate has independently opened it. */
export function createRealTradeCapRuntime(
  env: NodeJS.ProcessEnv = process.env,
) {
  const { path, config } = realConfigFromEnv(env);
  if (!config.signingEnabled) throw Error("REAL_SIGNING_NOT_ENABLED");
  if (!env.REAL_BOT_PRIVATE_KEY) throw Error("REAL_BOT_PRIVATE_KEY_REQUIRED");
  const keypair = Ed25519Keypair.fromSecretKey(env.REAL_BOT_PRIVATE_KEY);
  if (keypair.toSuiAddress() !== config.signerAddress)
    throw Error("REAL_SIGNER_IDENTITY_MISMATCH");
  const identity: RealIdentity = {
    network: config.network,
    balanceManagerId: config.balanceManagerId,
    poolKey: config.poolKey,
    tradeCapId: config.tradeCapId,
    signerAddress: config.signerAddress,
    sessionId: config.sessionId,
  };
  const db = new RealTradeCapDatabase(path);
  db.registerIdentity(identity);
  const client = new SuiGrpcClient({
    network: "testnet",
    transport: new GrpcWebFetchTransport({ baseUrl: config.grpcUrl }),
  });
  const builder = createDeepBookTransactionBuilder(client, config);
  const executor = new RealTradeCapExecutor(
    db,
    identity,
    builder,
    {
      address: keypair.toSuiAddress(),
      sign: async (bytes) => (await keypair.signTransaction(bytes)).signature,
    },
    {
      async send(bytes, signature): Promise<RealEffects> {
        const result = await client.executeTransaction({
          transaction: bytes,
          signatures: [signature],
          include: { effects: true },
        });
        const submitted = result.Transaction ?? result.FailedTransaction;
        if (!submitted?.digest) throw Error("REAL_EFFECTS_INCOMPLETE");
        const finalized = await client.waitForTransaction({
          digest: submitted.digest,
          include: { effects: true },
        });
        const transaction =
          finalized.Transaction ?? finalized.FailedTransaction;
        if (!transaction?.checkpoint) throw Error("REAL_EFFECTS_INCOMPLETE");
        const checkpointResponse = await fetch(config.graphqlUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `query Checkpoint($sequence: UInt53!) { checkpoint(sequenceNumber: $sequence) { digest } }`,
            variables: { sequence: Number(transaction.checkpoint) },
          }),
        });
        if (!checkpointResponse.ok) throw Error("REAL_EFFECTS_INCOMPLETE");
        const checkpointJson = (await checkpointResponse.json()) as {
          data?: { checkpoint?: { digest?: string } };
          errors?: unknown[];
        };
        if (checkpointJson.errors?.length || !checkpointJson.data)
          throw Error("REAL_EFFECTS_INCOMPLETE");
        const checkpointHash = checkpointJson.data?.checkpoint?.digest;
        if (!checkpointHash) throw Error("REAL_EFFECTS_INCOMPLETE");
        return {
          digest: transaction.digest,
          success: transaction.status.success,
          checkpoint: transaction.checkpoint,
          checkpointHash,
          events: [
            {
              chain: "sui:testnet",
              checkpoint: transaction.checkpoint,
              digest: transaction.digest,
              eventSequence: "effects:0",
              kind: "TX_EFFECTS",
              identity,
              raw: transaction.effects,
            },
          ],
          errorCode: transaction.status.error?.message,
        };
      },
    },
  );
  const reader = createDeepBookReadOnly(config, config.grpcUrl);
  const feeCache = new RealFeeCache(() => reader.snapshot());
  const executionAdapter = new RealTradeCapExecutionAdapter(
    executor,
    config,
    feeCache,
    new RealBookParamsCache(config),
  );
  const history = new IndexerGraphqlHistorySource(
    config.indexerUrl,
    config.graphqlUrl,
    identity,
    db.checkpoint(),
  );
  const reconciler = new RealReconciler(db, identity, history);
  return {
    executionAdapter,
    startReconciliation: () => startRealTradeCapReconciliation(reconciler),
    realReconciliation: () => ({
      nonTerminalSubmissions: db.nonTerminalSubmissions(identity).length,
    }),
    realExecution: () => ({ orderType: config.orderType }),
    realBalances: cacheRealBalances(reader.readBalances),
    liveProbe: () =>
      runRealLiveProbe({
        snapshot: async () => {
          const snapshot = await reader.snapshot();
          feeCache.observe(snapshot);
          return snapshot;
        },
        capValid: () => tradeCapValid(config.graphqlUrl, identity),
        historyPage: () => history.page(null),
      }),
  };
}

export const createRealTradeCapExecutionAdapter = (
  env: NodeJS.ProcessEnv = process.env,
) => createRealTradeCapRuntime(env).executionAdapter;
