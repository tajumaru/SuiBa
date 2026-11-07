import { createHash } from "node:crypto";
import type { ApiAccess } from "../../../packages/shared/src/api.ts";
import type { TradingPair } from "../../../packages/shared/src/index.ts";
import type { BotDatabase } from "../../../packages/database/src/index.ts";
import type { OperationMonitor } from "./operations.ts";

export interface ResetExpectation {
  version: 1;
  bootId: string;
  pair: TradingPair;
  generation: string;
  expectedError: string | null;
}
export const resetRefusalCodes = [
  "RESET_EMERGENCY_ACTIVE",
  "RESET_SCOPE_CHANGED",
  "RESET_NOT_PREDECESSOR",
  "RESET_BUSY",
] as const;
type Refusal = (typeof resetRefusalCodes)[number];

/** Captured before this pair's engine boots; activated before its scheduler runs. */
export class PredecessorReset {
  private readonly error: string | null;
  private readonly inheritedApis: string[];
  private monitor?: OperationMonitor;
  private original?: ResetExpectation;
  private acceptedGeneration?: string;
  private readonly initialRuntimeRevision: number;
  private readonly initialApiRevision: number;
  private changedDuringBoot = false;
  private readonly inheritedBlock: boolean;
  constructor(
    private readonly db: BotDatabase,
    private readonly api: ApiAccess,
    private readonly bootId: string,
    private readonly pair: TradingPair,
    private readonly firstVisit = true,
  ) {
    this.error = db.runtime().error;
    this.initialRuntimeRevision = db.runtimeRevision();
    this.initialApiRevision = api.resetFailureRevision();
    const persisted = db.get<
      {
        api: string;
        nextRetryAt?: number | null;
        exhausted?: boolean;
        circuitUntil?: number | null;
      }[]
    >("api_cooldowns");
    this.inheritedBlock =
      this.error !== null ||
      (Array.isArray(persisted) &&
        persisted.some(
          (s) =>
            s &&
            (s.exhausted === true ||
              (typeof s.nextRetryAt === "number" &&
                s.nextRetryAt > Date.now()) ||
              s.circuitUntil != null),
        ));
    this.inheritedApis = Array.isArray(persisted)
      ? persisted
          .filter(
            (s) =>
              s &&
              typeof s.api === "string" &&
              (s.exhausted || s.nextRetryAt != null || s.circuitUntil != null),
          )
          .map((s) => s.api)
      : [];
  }
  private generation() {
    return createHash("sha256")
      .update(
        JSON.stringify([
          this.bootId,
          this.pair,
          this.db.runtimeRevision(),
          this.api.resetFailureRevision(),
          this.monitor?.safety().generation,
        ]),
      )
      .digest("hex");
  }
  activate(monitor: OperationMonitor) {
    this.monitor = monitor;
    // monitor.boot has exactly one stop write. Never bless a failure occurring
    // between predecessor capture and activation, even if its text is identical.
    this.changedDuringBoot =
      this.db.runtimeRevision() !== this.initialRuntimeRevision + 1 ||
      this.api.resetFailureRevision() !== this.initialApiRevision ||
      this.db.runtime().error !== this.error;
    this.original = {
      version: 1,
      bootId: this.bootId,
      pair: this.pair,
      generation: this.generation(),
      expectedError:
        typeof this.error === "string" &&
        /^[A-Z][A-Z0-9_]{0,99}$/.test(this.error)
          ? this.error
          : null,
    };
    this.acceptedGeneration = this.original.generation;
  }
  private refusal(): Refusal | null {
    const runtime = this.db.runtime();
    if (runtime.emergency) return "RESET_EMERGENCY_ACTIVE";
    if (
      !this.firstVisit ||
      !this.original ||
      (this.error !== null && this.original.expectedError === null)
    )
      return "RESET_NOT_PREDECESSOR";
    if (
      runtime.running ||
      this.changedDuringBoot ||
      this.generation() !== this.acceptedGeneration ||
      runtime.error !== (this.applied ? null : this.error)
    )
      return "RESET_SCOPE_CHANGED";
    return null;
  }
  private applied = false;
  awaitingReset() {
    return (
      !this.applied &&
      (this.error !== null || (this.inheritedBlock && this.api.blocked()))
    );
  }
  needsWarmupAfterReset() {
    // The old cooldown may expire between the last held tick and this request.
    return this.inheritedBlock && !this.applied;
  }
  status() {
    const reason = this.refusal();
    return {
      ...this.original!,
      generation: reason ? this.generation() : this.original!.generation,
      eligible: reason === null,
      reason,
      pending: this.awaitingReset(),
    };
  }
  clear(expected: unknown = this.original) {
    const reason = this.refusal();
    if (reason) return reason;
    if (
      !expected ||
      typeof expected !== "object" ||
      Array.isArray(expected) ||
      Object.keys(expected).length !== 5 ||
      !Object.entries(this.original!).every(
        ([key, value]) => (expected as Record<string, unknown>)[key] === value,
      )
    )
      return "RESET_SCOPE_CHANGED";
    if (this.applied) return null; // A lost response can be retried, never re-authorized.
    let plan;
    try {
      plan = this.api.planPredecessorReset(
        this.inheritedApis,
        this.initialApiRevision,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "API_BACKOFF")
        return "RESET_BUSY";
      return "RESET_SCOPE_CHANGED";
    }
    this.db.transaction(() => {
      this.db.set("api_cooldowns", plan.snapshot);
      this.db.set("runtime", {
        ...this.db.runtime(),
        running: false,
        error: null,
      });
      this.monitor!.transition("MANUAL_RESET");
    });
    plan.apply();
    this.applied = true;
    this.acceptedGeneration = this.generation();
    return null;
  }
}
