import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import { realConfigFromEnv } from "./config.ts";
import { RealTradeCapDatabase } from "./database.ts";
import { createDeepBookTransactionBuilder } from "./deepbook-execution.ts";
import { RealTradeCapExecutor } from "./execution.ts";
import { RealTradeCapExecutionAdapter } from "./adapter.ts";
import type { RealEffects, RealIdentity } from "./types.ts";

/** Constructs the REAL-only execution boundary. No PAPER key or sender is
 * accepted here. The persisted control row remains halted across restart until
 * the complete resume gate has independently opened it. */
export function createRealTradeCapExecutionAdapter(
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
        };
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
  return new RealTradeCapExecutionAdapter(executor, config);
}
