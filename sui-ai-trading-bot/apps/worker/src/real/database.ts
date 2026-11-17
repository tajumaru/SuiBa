import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { RealHistoryEvent, RealIdentity } from "./types.ts";

const identityKey = (identity: RealIdentity) =>
  [
    identity.network,
    identity.balanceManagerId,
    identity.poolKey,
    identity.tradeCapId,
    identity.signerAddress,
    identity.sessionId,
  ].join(":");

export class RealTradeCapDatabase {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS real_identity(
        identity_key TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS real_submission_intents(
        digest TEXT PRIMARY KEY, tx_bytes_hash TEXT NOT NULL, internal_order_id TEXT NOT NULL,
        client_order_id TEXT NOT NULL, identity_key TEXT NOT NULL, intent_json TEXT NOT NULL,
        persisted_at INTEGER NOT NULL, sent_at INTEGER,
        FOREIGN KEY(identity_key) REFERENCES real_identity(identity_key)
      );
      CREATE TABLE IF NOT EXISTS real_ledger(
        chain TEXT NOT NULL, digest TEXT NOT NULL, event_sequence TEXT NOT NULL,
        checkpoint TEXT NOT NULL, kind TEXT NOT NULL, identity_key TEXT NOT NULL,
        event_json TEXT NOT NULL, applied_at INTEGER NOT NULL,
        PRIMARY KEY(chain,digest,event_sequence)
      );
      CREATE TABLE IF NOT EXISTS real_reconciliation_checkpoint(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), cursor TEXT, checkpoint TEXT NOT NULL,
        checkpoint_hash TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS real_latches(
        identity_key TEXT NOT NULL, code TEXT NOT NULL, detail TEXT NOT NULL,
        permanent INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
        PRIMARY KEY(identity_key,code)
      );
      CREATE TABLE IF NOT EXISTS real_balance_ledger(
        identity_key TEXT NOT NULL, asset TEXT NOT NULL,
        available_atomic TEXT NOT NULL DEFAULT '0', order_locked_atomic TEXT NOT NULL DEFAULT '0',
        settled_unclaimed_atomic TEXT NOT NULL DEFAULT '0', fee_atomic TEXT NOT NULL DEFAULT '0',
        gas_mist TEXT NOT NULL DEFAULT '0', PRIMARY KEY(identity_key,asset)
      );`);
  }

  registerIdentity(identity: RealIdentity, now = Date.now()) {
    const key = identityKey(identity);
    const existing = this.db
      .prepare("SELECT json FROM real_identity WHERE identity_key=?")
      .get(key) as { json: string } | undefined;
    if (!existing)
      this.db
        .prepare("INSERT INTO real_identity VALUES(?,?,?)")
        .run(key, JSON.stringify(identity), now);
    return key;
  }

  persistBeforeSend(input: {
    digest: string;
    txBytes: Uint8Array;
    internalOrderId: string;
    clientOrderId: string;
    identity: RealIdentity;
    intent: unknown;
    now?: number;
  }) {
    if (!/^\d+$/.test(input.clientOrderId))
      throw Error("REAL_CLIENT_ORDER_ID_INVALID");
    const key = this.registerIdentity(input.identity, input.now);
    const hash = createHash("sha256").update(input.txBytes).digest("hex");
    this.db
      .prepare(
        `INSERT INTO real_submission_intents
      (digest,tx_bytes_hash,internal_order_id,client_order_id,identity_key,intent_json,persisted_at)
      VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        input.digest,
        hash,
        input.internalOrderId,
        input.clientOrderId,
        key,
        JSON.stringify(input.intent),
        input.now ?? Date.now(),
      );
    return hash;
  }

  checkpoint() {
    return this.db
      .prepare(
        `SELECT cursor,checkpoint,checkpoint_hash AS checkpointHash
      FROM real_reconciliation_checkpoint WHERE singleton=1`,
      )
      .get() as
      | { cursor: string | null; checkpoint: string; checkpointHash: string }
      | undefined;
  }

  latch(
    identity: RealIdentity,
    code: string,
    detail: string,
    permanent = false,
  ) {
    const key = this.registerIdentity(identity);
    this.db
      .prepare(
        `INSERT INTO real_latches VALUES(?,?,?,?,?)
      ON CONFLICT(identity_key,code) DO UPDATE SET detail=excluded.detail,
      permanent=MAX(real_latches.permanent,excluded.permanent)`,
      )
      .run(key, code, detail, permanent ? 1 : 0, Date.now());
  }

  hasLatch(identity: RealIdentity) {
    return !!this.db
      .prepare("SELECT 1 FROM real_latches WHERE identity_key=? LIMIT 1")
      .get(identityKey(identity));
  }
  latchInfo(identity: RealIdentity, code: string) {
    return this.db
      .prepare(
        `SELECT detail,permanent FROM real_latches
      WHERE identity_key=? AND code=?`,
      )
      .get(identityKey(identity), code) as
      { detail: string; permanent: number } | undefined;
  }

  applyPage(
    identity: RealIdentity,
    events: RealHistoryEvent[],
    page: {
      cursor: string | null;
      checkpoint: string;
      checkpointHash: string;
    },
  ) {
    const expected = identityKey(identity);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        if (identityKey(event.identity) !== expected) {
          this.latch(
            identity,
            "REAL_IDENTITY_MISMATCH",
            JSON.stringify(event.identity),
          );
          continue;
        }
        const inserted = this.db
          .prepare(
            `INSERT INTO real_ledger
          VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(chain,digest,event_sequence) DO NOTHING`,
          )
          .run(
            event.chain,
            event.digest,
            event.eventSequence,
            event.checkpoint,
            event.kind,
            expected,
            JSON.stringify(event),
            Date.now(),
          );
        if (inserted.changes === 0) continue;
        if (event.asset) this.applyBalanceDelta(expected, event);
      }
      this.db
        .prepare(
          `INSERT INTO real_reconciliation_checkpoint VALUES(1,?,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET cursor=excluded.cursor,checkpoint=excluded.checkpoint,
        checkpoint_hash=excluded.checkpoint_hash,updated_at=excluded.updated_at`,
        )
        .run(page.cursor, page.checkpoint, page.checkpointHash, Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private applyBalanceDelta(key: string, event: RealHistoryEvent) {
    const asset = event.asset!;
    this.db
      .prepare(
        `INSERT INTO real_balance_ledger(identity_key,asset) VALUES(?,?)
      ON CONFLICT(identity_key,asset) DO NOTHING`,
      )
      .run(key, asset);
    const row = this.db
      .prepare(
        "SELECT * FROM real_balance_ledger WHERE identity_key=? AND asset=?",
      )
      .get(key, asset) as Record<string, string>;
    const add = (name: string, delta?: string) =>
      (BigInt(row[name]) + BigInt(delta ?? "0")).toString();
    this.db
      .prepare(
        `UPDATE real_balance_ledger SET available_atomic=?,order_locked_atomic=?,
      settled_unclaimed_atomic=?,fee_atomic=?,gas_mist=? WHERE identity_key=? AND asset=?`,
      )
      .run(
        add("available_atomic", event.availableAtomicDelta),
        add("order_locked_atomic", event.orderLockedAtomicDelta),
        add("settled_unclaimed_atomic", event.settledUnclaimedAtomicDelta),
        add("fee_atomic", event.feeAtomic),
        add("gas_mist", event.gasMist),
        key,
        asset,
      );
  }

  ledgerCount() {
    return Number(
      (
        this.db.prepare("SELECT COUNT(*) AS n FROM real_ledger").get() as {
          n: number;
        }
      ).n,
    );
  }
  close() {
    this.db.close();
  }
}
