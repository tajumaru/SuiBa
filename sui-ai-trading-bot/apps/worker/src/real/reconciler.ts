import type { RealHistorySource, RealIdentity } from "./types.ts";
import { RealTradeCapDatabase } from "./database.ts";

export class RealReconciler {
  constructor(
    private readonly db: RealTradeCapDatabase,
    private readonly identity: RealIdentity,
    private readonly source: RealHistorySource,
  ) {}

  async reconcileAllPages() {
    const stored = this.db.checkpoint();
    let cursor = stored?.cursor ?? null;
    let checkpoint = stored;
    let pages = 0;
    let events = 0;
    for (;;) {
      const page = await this.source.page(cursor);
      if (
        checkpoint &&
        page.checkpoint === checkpoint.checkpoint &&
        page.checkpointHash !== checkpoint.checkpointHash
      ) {
        this.db.latch(
          this.identity,
          "REAL_CHECKPOINT_HASH_MISMATCH",
          `${checkpoint.checkpointHash}:${page.checkpointHash}`,
        );
        throw Error("REAL_CHECKPOINT_HASH_MISMATCH");
      }
      if (
        checkpoint &&
        BigInt(page.checkpoint) < BigInt(checkpoint.checkpoint)
      ) {
        this.db.latch(
          this.identity,
          "REAL_CHECKPOINT_REGRESSION",
          `${checkpoint.checkpoint}:${page.checkpoint}`,
        );
        throw Error("REAL_CHECKPOINT_REGRESSION");
      }
      this.db.applyPage(this.identity, page.events, {
        cursor: page.nextCursor,
        checkpoint: page.checkpoint,
        checkpointHash: page.checkpointHash,
      });
      pages++;
      events += page.events.length;
      if (page.nextCursor === null) {
        for (const submission of this.db.nonTerminalSubmissions(
          this.identity,
        )) {
          const status = await this.source.submissionStatus?.(
            submission.digest,
          );
          if (status) this.db.markSubmission(submission.digest, status);
        }
        return {
          pages,
          events,
          nextCursor: null as null,
        };
      }
      if (page.nextCursor === cursor)
        throw Error("REAL_RECONCILIATION_CURSOR_STALLED");
      cursor = page.nextCursor;
      checkpoint = {
        cursor,
        checkpoint: page.checkpoint,
        checkpointHash: page.checkpointHash,
      };
    }
  }
}
