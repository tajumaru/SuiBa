import type {
  RealEffects,
  RealIdentity,
  RealOperation,
  RealBuiltTransaction,
  RealEngineChecksRecord,
} from "./types.ts";
import { RealTradeCapDatabase } from "./database.ts";

export interface RealTransactionBuilder {
  place(input: RealExecutionIntent): Promise<RealBuiltTransaction>;
  cancel(input: RealCancelIntent): Promise<RealBuiltTransaction>;
}
export interface RealBotSigner {
  address: string;
  sign(bytes: Uint8Array): Promise<string>;
}
export interface RealSender {
  send(bytes: Uint8Array, signature: string): Promise<RealEffects>;
}
export interface RealExecutionIntent {
  internalOrderId: string;
  clientOrderId: string;
  side: "BUY" | "SELL";
  intent: unknown;
}
export interface RealCancelIntent {
  internalOrderId: string;
  clientOrderId: string;
  targetOrderId: string;
  intent: unknown;
  confirmedFailedPreviousCancel?: boolean;
}
export type RealExecutionResult = {
  status: "SUCCEEDED" | "REJECTED" | "UNKNOWN";
  digest?: string;
  errorCode?: string;
  onchainOrderId?: string;
};

/** One serialized signing queue. The generation check after durable persistence is
 * the fence that prevents a pre-stop queued transaction from signing later. */
export class RealTradeCapExecutor {
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private db: RealTradeCapDatabase,
    private identity: RealIdentity,
    private builder: RealTransactionBuilder,
    private signer: RealBotSigner,
    private sender: RealSender,
  ) {
    if (signer.address !== identity.signerAddress)
      throw Error("REAL_SIGNER_IDENTITY_MISMATCH");
  }
  execute(intent: RealExecutionIntent) {
    return this.serial(() => this.submit("PLACE", intent));
  }
  acceptStop() {
    this.db.acceptStop(this.identity);
  }
  recordEngineChecks(record: Omit<RealEngineChecksRecord, "identity">) {
    this.db.persistEngineChecks({ ...record, identity: this.identity });
  }
  cancel(intent: RealCancelIntent) {
    if (intent.confirmedFailedPreviousCancel !== true)
      return Promise.resolve<RealExecutionResult>({
        status: "REJECTED",
        errorCode: "REAL_CANCEL_NOT_CONFIRMED_FAILED",
      });
    return this.serial(() => this.submit("CANCEL", intent));
  }
  private serial<T>(fn: () => Promise<T>) {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  private async submit(
    operation: RealOperation,
    intent: RealExecutionIntent | RealCancelIntent,
  ): Promise<RealExecutionResult> {
    if (this.db.hasNonTerminalSubmission(this.identity))
      return { status: "REJECTED", errorCode: "REAL_RECONCILIATION_PENDING" };
    const generation = this.db.control(this.identity).generation;
    try {
      this.db.assertMaySign(this.identity, generation);
    } catch {
      return { status: "REJECTED", errorCode: "REAL_SIGNING_HALTED" };
    }
    const side = operation === "PLACE" ? (intent as RealExecutionIntent).side : undefined;
    if (side === "BUY" && this.db.hasUnreflectedBuy(this.identity))
      return { status: "REJECTED", errorCode: "REAL_REFLECTION_PENDING" };
    const built =
      operation === "PLACE"
        ? await this.builder.place(intent as RealExecutionIntent)
        : await this.builder.cancel(intent as RealCancelIntent);
    // Any error here escapes before sign/send. This ordering is a safety contract.
    this.db.persistBeforeSend({
      digest: built.digest,
      txBytes: built.bytes,
      internalOrderId: intent.internalOrderId,
      clientOrderId: intent.clientOrderId,
      identity: this.identity,
      intent: intent.intent,
      operation,
      side,
      targetOrderId:
        "targetOrderId" in intent ? intent.targetOrderId : undefined,
      generation,
    });
    try {
      this.db.assertMaySign(this.identity, generation);
      const signature = await this.signer.sign(built.bytes);
      this.db.assertMaySign(this.identity, generation);
      this.db.markSent(built.digest);
      const effects = await this.sender.send(built.bytes, signature);
      this.db.applyEffects(this.identity, effects);
      return effects.success
        ? {
            status: "SUCCEEDED",
            digest: built.digest,
            onchainOrderId: effects.onchainOrderId,
          }
        : {
            status: "REJECTED",
            digest: built.digest,
            errorCode: effects.errorCode ?? "REAL_CHAIN_REJECTED",
          };
    } catch (error) {
      if (error instanceof Error && error.message === "REAL_SIGNING_HALTED")
        throw error;
      this.db.markSubmission(built.digest, "UNKNOWN");
      return {
        status: "UNKNOWN",
        digest: built.digest,
        errorCode: "REAL_SUBMISSION_UNKNOWN",
      };
    }
  }
}
