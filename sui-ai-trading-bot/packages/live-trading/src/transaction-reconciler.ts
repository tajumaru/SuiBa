import { LiveError } from "./policy.ts";
import type { LiveStore } from "./types.ts";
/** Phase 5 extension point only. Unknown persisted submission state always blocks new work. */
export class TransactionReconciler {
  constructor(private store: LiveStore) {}
  assertNoUnresolvedSubmission() {
    if (this.store.state().activeOrder) {
      this.store.stop("UNRESOLVED_ORDER");
      throw new LiveError("UNRESOLVED_ORDER");
    }
  }
  async reconcile(_digest: string): Promise<never> {
    this.store.stop("RECONCILIATION_NOT_IMPLEMENTED");
    throw new LiveError("PHASE_5_NOT_IMPLEMENTED");
  }
}
