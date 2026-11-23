import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  RealEffects,
  RealHistoryEvent,
  RealIdentity,
  RealEngineChecksRecord,
  RealOperation,
} from "./types.ts";

export interface RealBalanceBaseline {
  assets: Record<
    "SUI" | "DBUSDC" | "DEEP",
    {
      availableAtomic: string;
      lockedAtomic: string;
      settledUnclaimedAtomic: string;
      owedAtomic: string;
    }
  >;
  botGasSuiMist: string;
  ledgerOffsets?: Record<
    "SUI" | "DBUSDC" | "DEEP",
    {
      availableAtomic: string;
      lockedAtomic: string;
      settledUnclaimedAtomic: string;
      feeAtomic: string;
      gasMist: string;
    }
  >;
  recordedAt: number;
}

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
        persisted_at INTEGER NOT NULL, sent_at INTEGER, operation TEXT NOT NULL DEFAULT 'PLACE',
        target_order_id TEXT, generation INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'SUBMITTING', terminal_at INTEGER,
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
      );
      CREATE TABLE IF NOT EXISTS real_control(
        identity_key TEXT PRIMARY KEY, halted INTEGER NOT NULL DEFAULT 1,
        generation INTEGER NOT NULL DEFAULT 0, stop_accepted_at INTEGER,
        host_stopped_at INTEGER, chain_stopped_at INTEGER,
        approval_json TEXT, approved_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS real_engine_checks(
        identity_key TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL, record_json TEXT NOT NULL,
        FOREIGN KEY(identity_key) REFERENCES real_identity(identity_key)
      );
      CREATE TABLE IF NOT EXISTS real_balance_baseline(
        identity_key TEXT PRIMARY KEY, baseline_json TEXT NOT NULL, recorded_at INTEGER NOT NULL,
        FOREIGN KEY(identity_key) REFERENCES real_identity(identity_key)
      );`);
    const submissionColumns = new Set(
      (
        this.db.prepare("PRAGMA table_info(real_submission_intents)").all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    );
    for (const [name, definition] of [
      ["operation", "TEXT NOT NULL DEFAULT 'PLACE'"],
      ["target_order_id", "TEXT"],
      ["generation", "INTEGER NOT NULL DEFAULT 0"],
      ["state", "TEXT NOT NULL DEFAULT 'SUBMITTING'"],
      ["terminal_at", "INTEGER"],
      ["side", "TEXT"],
      ["reflected_at", "INTEGER"],
    ] as const) {
      if (!submissionColumns.has(name))
        this.db.exec(
          `ALTER TABLE real_submission_intents ADD COLUMN ${name} ${definition}`,
        );
    }
    if (!submissionColumns.has("side"))
      this.db.exec(`UPDATE real_submission_intents
        SET side=json_extract(intent_json, '$.side')
        WHERE operation='PLACE' AND json_extract(intent_json, '$.side') IN ('BUY','SELL')`);
    if (!submissionColumns.has("reflected_at"))
      this.db.exec(`UPDATE real_submission_intents
        SET reflected_at=terminal_at WHERE state='FAILED'`);
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
    operation?: RealOperation;
    side?: "BUY" | "SELL";
    targetOrderId?: string;
    generation?: number;
    now?: number;
  }) {
    if (!/^\d+$/.test(input.clientOrderId))
      throw Error("REAL_CLIENT_ORDER_ID_INVALID");
    const key = this.registerIdentity(input.identity, input.now);
    const hash = createHash("sha256").update(input.txBytes).digest("hex");
    this.db
      .prepare(
        `INSERT INTO real_submission_intents
      (digest,tx_bytes_hash,internal_order_id,client_order_id,identity_key,intent_json,persisted_at,
       operation,target_order_id,generation,side)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.digest,
        hash,
        input.internalOrderId,
        input.clientOrderId,
        key,
        JSON.stringify(input.intent),
        input.now ?? Date.now(),
        input.operation ?? "PLACE",
        input.targetOrderId ?? null,
        input.generation ?? this.control(input.identity).generation,
        input.operation === "CANCEL" ? null : input.side ?? null,
      );
    return hash;
  }

  control(identity: RealIdentity) {
    const key = this.registerIdentity(identity);
    this.db
      .prepare(
        `INSERT INTO real_control(identity_key) VALUES(?)
      ON CONFLICT(identity_key) DO NOTHING`,
      )
      .run(key);
    return this.db
      .prepare(
        `SELECT halted,generation,stop_accepted_at AS stopAcceptedAt,
      host_stopped_at AS hostStoppedAt,chain_stopped_at AS chainStoppedAt,
      approval_json AS approvalJson,approved_at AS approvedAt
      FROM real_control WHERE identity_key=?`,
      )
      .get(key) as {
      halted: number;
      generation: number;
      stopAcceptedAt: number | null;
      hostStoppedAt: number | null;
      chainStoppedAt: number | null;
      approvalJson: string | null;
      approvedAt: number | null;
    };
  }

  acceptStop(identity: RealIdentity, now = Date.now()) {
    const current = this.control(identity);
    this.db
      .prepare(
        `UPDATE real_control SET halted=1,generation=?,stop_accepted_at=?,
      approval_json=NULL,approved_at=NULL WHERE identity_key=?`,
      )
      .run(current.generation + 1, now, identityKey(identity));
    return current.generation + 1;
  }

  markHostStopped(identity: RealIdentity, now = Date.now()) {
    this.control(identity);
    this.db
      .prepare("UPDATE real_control SET host_stopped_at=? WHERE identity_key=?")
      .run(now, identityKey(identity));
  }

  markChainStopped(identity: RealIdentity, now = Date.now()) {
    this.control(identity);
    this.db
      .prepare(
        "UPDATE real_control SET chain_stopped_at=? WHERE identity_key=?",
      )
      .run(now, identityKey(identity));
  }

  approveResume(
    identity: RealIdentity,
    evidence: Record<string, unknown>,
    now = Date.now(),
  ) {
    if (this.latchInfo(identity, "REAL_UNIDENTIFIABLE_PREDECESSOR")?.permanent)
      throw Error("REAL_UNIDENTIFIABLE_PREDECESSOR");
    const required = [
      "checkpoint",
      "checkpointHash",
      "identityKey",
      "ownerApproval",
    ];
    if (required.some((key) => !evidence[key]))
      throw Error("REAL_RESUME_APPROVAL_INCOMPLETE");
    this.control(identity);
    this.db
      .prepare(
        "UPDATE real_control SET approval_json=?,approved_at=? WHERE identity_key=?",
      )
      .run(JSON.stringify(evidence), now, identityKey(identity));
  }

  openSigningGate(identity: RealIdentity, checks: Record<string, boolean>) {
    if (this.latchInfo(identity, "REAL_UNIDENTIFIABLE_PREDECESSOR")?.permanent)
      throw Error("REAL_UNIDENTIFIABLE_PREDECESSOR");
    const required = [
      "allTransactionsTerminal",
      "historyComplete",
      "ledgerIdempotent",
      "balancesExplained",
      "noOpenOrders",
      "identityMatches",
      "capValid",
      "gasSufficient",
      "deepSufficient",
      "riskAllowed",
      "profitGuardAllowed",
      "marketHealthy",
    ];
    const control = this.control(identity);
    if (!control.approvalJson || required.some((key) => checks[key] !== true))
      throw Error("REAL_RESUME_GATE_CLOSED");
    this.db
      .prepare("UPDATE real_control SET halted=0 WHERE identity_key=?")
      .run(identityKey(identity));
  }

  assertMaySign(identity: RealIdentity, generation: number) {
    const state = this.control(identity);
    if (state.halted || state.generation !== generation)
      throw Error("REAL_SIGNING_HALTED");
  }

  markSent(digest: string, now = Date.now()) {
    this.db
      .prepare("UPDATE real_submission_intents SET sent_at=? WHERE digest=?")
      .run(now, digest);
  }
  markSubmission(
    digest: string,
    state: "UNKNOWN" | "SUCCEEDED" | "FAILED",
    now = Date.now(),
  ) {
    this.db
      .prepare(
        `UPDATE real_submission_intents SET state=?,terminal_at=?,
         reflected_at=CASE WHEN ? = 'FAILED' THEN COALESCE(reflected_at, ?) ELSE reflected_at END
         WHERE digest=?`,
      )
      .run(state, state === "UNKNOWN" ? null : now, state, now, digest);
  }
  hasNonTerminalSubmission(identity: RealIdentity) {
    return !!this.db
      .prepare(
        `SELECT 1 FROM real_submission_intents
      WHERE identity_key=? AND state IN ('SUBMITTING','UNKNOWN') LIMIT 1`,
      )
      .get(identityKey(identity));
  }
  hasUnreflectedBuy(identity: RealIdentity) {
    return !!this.db.prepare(
      `SELECT 1 FROM real_submission_intents
       WHERE identity_key=? AND operation='PLACE' AND side='BUY'
       AND state='SUCCEEDED' AND reflected_at IS NULL LIMIT 1`,
    ).get(identityKey(identity));
  }

  markTradeReflected(identity: RealIdentity, event: RealHistoryEvent, now = Date.now()) {
    if (event.kind !== "TRADE_FILL" || !event.clientOrderId ||
        identityKey(event.identity) !== identityKey(identity)) return;
    const key = identityKey(identity);
    this.db.prepare(
      `UPDATE real_submission_intents SET reflected_at=?
       WHERE identity_key=? AND digest=? AND client_order_id=? AND reflected_at IS NULL
       AND EXISTS (SELECT 1 FROM real_ledger
         WHERE identity_key=? AND chain=? AND digest=? AND event_sequence=? AND kind='TRADE_FILL')`,
    ).run(now, key, event.digest, event.clientOrderId, key, event.chain, event.digest, event.eventSequence);
  }

  markTerminalReflected(identity: RealIdentity, checkedAfter: number, now = Date.now()) {
    this.db.prepare(
      `UPDATE real_submission_intents SET reflected_at=?
       WHERE identity_key=? AND state IN ('SUCCEEDED','FAILED') AND terminal_at < ?
       AND reflected_at IS NULL`,
    ).run(now, identityKey(identity), checkedAfter);
  }

  nonTerminalSubmissions(identity: RealIdentity) {
    return this.db
      .prepare(
        `SELECT digest,state FROM real_submission_intents
        WHERE identity_key=? AND state IN ('SUBMITTING','UNKNOWN') ORDER BY persisted_at`,
      )
      .all(identityKey(identity)) as {
      digest: string;
      state: "SUBMITTING" | "UNKNOWN";
    }[];
  }

  applyEffects(identity: RealIdentity, effects: RealEffects) {
    this.applyPage(identity, effects.events, {
      cursor: this.checkpoint()?.cursor ?? null,
      checkpoint: effects.checkpoint,
      checkpointHash: effects.checkpointHash,
    });
    this.markSubmission(
      effects.digest,
      effects.success ? "SUCCEEDED" : "FAILED",
    );
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
        add(
          "gas_mist",
          event.gasMist && this.isBotSubmission(key, event.digest) &&
            !this.hasOtherEffectsGas(key, event)
            ? event.gasMist
            : undefined,
        ),
        key,
        asset,
      );
  }

  private hasOtherEffectsGas(key: string, event: RealHistoryEvent) {
    if (event.kind !== "TX_EFFECTS" ||
        (event.eventSequence !== "effects:0" && event.eventSequence !== "effects:history"))
      return false;
    return !!this.db.prepare(
      `SELECT 1 FROM real_ledger
       WHERE identity_key=? AND chain=? AND digest=? AND event_sequence=?
       AND kind='TX_EFFECTS' AND json_extract(event_json, '$.asset')='SUI'
       AND json_extract(event_json, '$.gasMist') IS NOT NULL`,
    ).get(key, event.chain, event.digest,
      event.eventSequence === "effects:0" ? "effects:history" : "effects:0");
  }

  private isBotSubmission(key: string, digest: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM real_submission_intents WHERE identity_key=? AND digest=?",
      )
      .get(key, digest);
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
  ledgerEvents(identity: RealIdentity) {
    return (
      this.db
        .prepare(
          "SELECT event_json AS eventJson FROM real_ledger WHERE identity_key=? ORDER BY applied_at",
        )
        .all(identityKey(identity)) as { eventJson: string }[]
    ).map((row) => JSON.parse(row.eventJson) as RealHistoryEvent);
  }
  allLedgerEvents() {
    return (
      this.db
        .prepare("SELECT event_json AS eventJson FROM real_ledger ORDER BY applied_at")
        .all() as { eventJson: string }[]
    ).map((row) => JSON.parse(row.eventJson) as RealHistoryEvent);
  }
  appliedTradeFeeCount(identity: RealIdentity) {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM real_ledger WHERE identity_key=? AND kind='TRADE_FEE'",
    ).get(identityKey(identity));
    return Number(row?.n);
  }

  balanceLedger(identity: RealIdentity) {
    return this.db
      .prepare(
        `SELECT asset,available_atomic AS availableAtomic,
        order_locked_atomic AS orderLockedAtomic,
        settled_unclaimed_atomic AS settledUnclaimedAtomic,
        fee_atomic AS feeAtomic,gas_mist AS gasMist
        FROM real_balance_ledger WHERE identity_key=? ORDER BY asset`,
      )
      .all(identityKey(identity)) as Array<Record<string, string>>;
  }
  balanceBaseline(identity: RealIdentity) {
    const row = this.db
      .prepare(
        `SELECT baseline_json AS baselineJson,recorded_at AS recordedAt
        FROM real_balance_baseline WHERE identity_key=?`,
      )
      .get(identityKey(identity)) as
      { baselineJson: string; recordedAt: number } | undefined;
    if (!row) return undefined;
    try {
      const baseline = JSON.parse(row.baselineJson) as RealBalanceBaseline;
      return baseline.recordedAt === row.recordedAt ? baseline : undefined;
    } catch {
      return undefined;
    }
  }
  recordBalanceBaseline(
    identity: RealIdentity,
    baseline: Omit<RealBalanceBaseline, "recordedAt">,
    now = Date.now(),
  ) {
    if (this.latchInfo(identity, "REAL_UNIDENTIFIABLE_PREDECESSOR")?.permanent)
      throw Error("REAL_UNIDENTIFIABLE_PREDECESSOR");
    const key = this.registerIdentity(identity, now);
    const value: RealBalanceBaseline = { ...baseline, recordedAt: now };
    this.db
      .prepare(
        `INSERT INTO real_balance_baseline VALUES(?,?,?)
        ON CONFLICT(identity_key) DO UPDATE SET
        baseline_json=excluded.baseline_json,recorded_at=excluded.recorded_at`,
      )
      .run(key, JSON.stringify(value), now);
    return value;
  }
  identityKey(identity: RealIdentity) {
    return identityKey(identity);
  }
  identityRegistered(identity: RealIdentity) {
    const key = identityKey(identity);
    const row = this.db
      .prepare("SELECT json FROM real_identity WHERE identity_key=?")
      .get(key) as { json: string } | undefined;
    return row?.json === JSON.stringify(identity);
  }
  persistEngineChecks(record: RealEngineChecksRecord) {
    const key = this.registerIdentity(record.identity, record.recordedAt);
    this.db
      .prepare(
        `INSERT INTO real_engine_checks VALUES(?,?,?)
        ON CONFLICT(identity_key) DO UPDATE SET
        recorded_at=excluded.recorded_at,record_json=excluded.record_json`,
      )
      .run(key, record.recordedAt, JSON.stringify(record));
  }
  latestEngineChecks(identity: RealIdentity) {
    const row = this.db
      .prepare(
        `SELECT recorded_at AS recordedAt,record_json AS recordJson
        FROM real_engine_checks WHERE identity_key=?`,
      )
      .get(identityKey(identity)) as
      { recordedAt: number; recordJson: string } | undefined;
    if (!row) return undefined;
    try {
      const record = JSON.parse(row.recordJson) as RealEngineChecksRecord;
      return record.recordedAt === row.recordedAt ? record : undefined;
    } catch {
      return undefined;
    }
  }
  close() {
    this.db.close();
  }
}
