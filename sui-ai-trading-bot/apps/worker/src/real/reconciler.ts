import { createHash } from "node:crypto";
import type {
  RealHistoryEvent,
  RealHistorySource,
  RealIdentity,
} from "./types.ts";
import { RealTradeCapDatabase } from "./database.ts";

const ledgerKey = (event: RealHistoryEvent) =>
  JSON.stringify([event.chain, event.digest, event.eventSequence]);

const eventHash = ({ identity, ...event }: RealHistoryEvent) =>
  createHash("sha256").update(JSON.stringify(event)).digest("hex");

function isAtOrBefore(event: RealHistoryEvent, applied: RealHistoryEvent) {
  const checkpoint = BigInt(event.checkpoint) - BigInt(applied.checkpoint);
  if (checkpoint !== 0n) return checkpoint < 0n;
  if (event.eventSequence !== applied.eventSequence)
    return event.eventSequence < applied.eventSequence;
  return event.digest <= applied.digest;
}

function isReplay(events: RealHistoryEvent[], ledger: RealHistoryEvent[]) {
  const last = events.at(-1);
  if (!last || !ledger.some((applied) => isAtOrBefore(last, applied)))
    return false;
  const appliedByKey = new Map(ledger.map((event) => [ledgerKey(event), event]));
  return events.every((event) => {
    const applied = appliedByKey.get(ledgerKey(event));
    return applied !== undefined && eventHash(event) === eventHash(applied);
  });
}

export class RealReconciler {
  constructor(
    private readonly db: RealTradeCapDatabase,
    private readonly identity: RealIdentity,
    private readonly source: RealHistorySource,
    private readonly balanceCheck?: () => Promise<boolean>,
  ) {}

  async reconcileAllPages() {
    let cursor = this.db.checkpoint()?.cursor ?? null;
    let pages = 0;
    let events = 0;
    for (;;) {
      const page = await this.source.page(cursor);
      const checkpoint = this.db.checkpoint();
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
      const replay =
        checkpoint &&
        page.events.length > 0 &&
        isReplay(page.events, this.db.allLedgerEvents());
      if (!replay) {
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
        const before = this.db.ledgerCount();
        this.db.applyPage(this.identity, page.events, {
          cursor: page.nextCursor,
          checkpoint: page.checkpoint,
          checkpointHash: page.checkpointHash,
        });
        events += this.db.ledgerCount() - before;
      }
      for (const event of page.events) this.db.markTradeReflected(this.identity, event);
      pages++;
      if (page.nextCursor === null) {
        for (const submission of this.db.nonTerminalSubmissions(
          this.identity,
        )) {
          const status = await this.source.submissionStatus?.(
            submission.digest,
          );
          if (status) this.db.markSubmission(submission.digest, status);
        }
        if (this.balanceCheck) {
          const checkedAfter = Date.now();
          if (await this.balanceCheck())
            this.db.markTerminalReflected(this.identity, checkedAfter);
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
    }
  }
}
