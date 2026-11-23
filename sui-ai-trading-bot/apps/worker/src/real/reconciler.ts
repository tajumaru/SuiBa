import { createHash } from "node:crypto";
import type {
  RealHistoryEvent,
  RealHistorySource,
  RealIdentity,
} from "./types.ts";
import { RealTradeCapDatabase } from "./database.ts";

const ledgerKey = (event: RealHistoryEvent) =>
  JSON.stringify([event.chain, event.digest, event.eventSequence]);

// キーの並び順に依存しない文字列化（入れ子のキーもそろえる）。
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
};

// 「同じ出来事か」は台帳の中身だけで比べる。identity は Cap 交換で変わり、
// timestampMs は後から足された付随情報で、旧コードが保存した出来事には無い。
// どちらも判定から外さないと、保存済みの出来事を再取得しただけで別物になる。
const eventHash = ({ identity, timestampMs, ...event }: RealHistoryEvent) =>
  createHash("sha256").update(stableStringify(event)).digest("hex");

function firstUnmatchedKey(
  events: RealHistoryEvent[],
  ledger: RealHistoryEvent[],
) {
  const appliedByKey = new Map(
    ledger.map((event) => [ledgerKey(event), event]),
  );
  for (const event of events) {
    const applied = appliedByKey.get(ledgerKey(event));
    if (!applied || eventHash(event) !== eventHash(applied))
      return ledgerKey(event);
  }
  return "order";
}

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
      const ledgerEvents = this.db.allLedgerEvents();
      const replay =
        checkpoint &&
        page.events.length > 0 &&
        isReplay(page.events, ledgerEvents);
      if (!replay) {
        if (
          checkpoint &&
          BigInt(page.checkpoint) < BigInt(checkpoint.checkpoint)
        ) {
          this.db.latch(
            this.identity,
            "REAL_CHECKPOINT_REGRESSION",
            `${checkpoint.checkpoint}:${page.checkpoint}:${firstUnmatchedKey(page.events, ledgerEvents)}`,
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
