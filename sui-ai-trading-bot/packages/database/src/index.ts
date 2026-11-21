import { timeSql } from "../../shared/src/api-timing.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaults,
  Decimal,
  settingsSchema,
  type Settings,
  type Runtime,
  type Portfolio,
  type Candle,
  type TradingDecision,
  type Indicators,
} from "../../shared/src/index.ts";
import { initialPortfolio, type Fill } from "../../paper-trading/src/index.ts";
import type { CandidateAudit } from "../../shared/src/operations.ts";
import type { AccountingCheck } from "../../paper-trading/src/reconciliation.ts";
import {
  partyLevel,
  partyMembers,
  type PartyMember,
} from "../../shared/src/party.ts";

type PartyRecord = { member: PartyMember; count: number; notifiedLevel: number };

function shieldRejection(json: string) {
  return `json_extract(${json},'$.side') = 'BUY'
    AND json_extract(${json},'$.finalAction') = 'WAIT'
    AND (
      (json_type(${json},'$.profitGuard.evaluated') = 'true'
        AND json_type(${json},'$.profitGuard.allowed') = 'false')
      OR EXISTS (
        SELECT 1 FROM json_each(${json},'$.reasons')
        WHERE type = 'text' AND value GLOB 'PROFIT_GUARD_*'
      )
    )`;
}

const eventTables = [
  "forecast_records",
  "forecast_answers",
  "forecast_calibrations",
  "forecast_imports",
  "technical_indicators",
  "strategy_decisions",
  "shadow_decisions",
  "paper_orders",
  "paper_trades",
  "portfolio_snapshots",
  "risk_events",
  "bot_settings",
  "profit_assessments",
  "backtest_runs",
  "operation_candidates",
  "operation_events",
  "paper_checks",
  "validation_events",
  "cycle_audits",
  "sui_observations",
] as const;
type EventTable = (typeof eventTables)[number];
export type MemwalEpisodeKind = "shadow" | "daily_review" | "narration";
export interface MemwalOutboxRow {
  id: string;
  kind: MemwalEpisodeKind;
  text: string;
  sourceId: string;
  createdAt: number;
  sentAt: number | null;
  jobId: string | null;
  attempts: number;
}
export const RETENTION_FULL_EVIDENCE_DAYS = 30;
export const LIQUIDATION_RETENTION_DAYS = RETENTION_FULL_EVIDENCE_DAYS;
export const RETENTION_CHUNK_ROWS = 16;
export const NARRATION_RETENTION_DAYS = 30;
export const NARRATION_RETENTION_ROWS = 50_000;
export const NARRATION_RETENTION_CHUNK_ROWS = 200;
const retentionVersion = 1;

export interface NarrationEntry {
  seq: number;
  id: string;
  pair: string;
  sourceKey: string;
  kind: string;
  occurredAt: number;
  createdAt: number;
  json: unknown;
}

export interface NarrationState {
  pair: string;
  version: number;
  updatedAt: number;
  json: unknown;
}

type RetentionRow = { id: string; json: string };

function compactDecision(value: Record<string, unknown>) {
  const evidence =
    value.evidence && typeof value.evidence === "object"
      ? (value.evidence as Record<string, unknown>)
      : null;
  const inputs =
    evidence?.inputs && typeof evidence.inputs === "object"
      ? (evidence.inputs as Record<string, unknown>)
      : null;
  return {
    _retention: retentionVersion,
    action: value.action,
    confidence: value.confidence,
    stopLossPct: value.stopLossPct,
    takeProfitPct: value.takeProfitPct,
    timestamp: value.timestamp,
    ...(value.sellPurpose === undefined
      ? {}
      : { sellPurpose: value.sellPurpose }),
    ...(evidence === null
      ? {}
      : {
          evidence: {
            version: evidence.version,
            evaluatedAt: evidence.evaluatedAt,
            candleTimestamp: evidence.candleTimestamp,
            previousCandleTimestamp: evidence.previousCandleTimestamp,
            inputs: {
              price: inputs?.price,
              entryPrice: inputs?.entryPrice,
            },
            conditions: evidence.conditions,
            selectedRule: evidence.selectedRule,
          },
        }),
  };
}

function compactCycleAudit(value: Record<string, unknown>) {
  const keys = [
    "cycleId",
    "phase",
    "beganAt",
    "endedAt",
    "runningAtStart",
    "runningAtEnd",
    "outcome",
    "action",
    "error",
    "failureDetail",
    "candidateId",
    "orderId",
  ] as const;
  return Object.fromEntries([
    ["_retention", retentionVersion],
    ...keys
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  ]);
}
/**
 * Timing metadata for one synchronous persistence operation. Emitted
 * only when BotDatabase.perfSink is installed (detailed performance
 * metrics, opt-in via scripts/preflight-detailed-metrics.mjs). Carries
 * no SQL text, no parameters and no stored values: table/key names are
 * code constants, and the only value-derived fields are the cycle
 * audit's own cycleId/phase, which are correlation keys, not secrets.
 * Phase split: append/set/saveCandles separate JSON.stringify time
 * (jsonMs) from statement execution time (sqlMs); transaction separates
 * BEGIN (beginMs), callback body (bodyMs) and COMMIT/ROLLBACK
 * (commitMs/rollbackMs). A transaction record's duration INCLUDES the
 * nested append/set/saveCandles records emitted inside it; the views
 * overlap by design and must never be added together.
 */
export interface SqlitePerfRecord {
  op: "append" | "set" | "saveCandles" | "transaction";
  table: string | null;
  key: string | null;
  rows: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  jsonMs: number | null;
  sqlMs: number | null;
  beginMs: number | null;
  bodyMs: number | null;
  commitMs: number | null;
  rollbackMs: number | null;
  ok: boolean;
  errorCode: number | null;
  cycleId: string | null;
  cyclePhase: string | null;
}
// Timings are inclusive. A transaction and its nested writes can overlap.
const timedMethods = [
  "displayVersion",
  "get",
  "set",
  "runtime",
  "portfolio",
  "settings",
  "recordProfit",
  "transaction",
  "append",
  "enqueueMemwal",
  "memwalPending",
  "memwalSent",
  "memwalFailed",
  "memwalStatus",
  "reserveShadowCall",
  "shadowLastCall",
  "shadowLastDecision",
  "history",
  "orderHistory",
  "hasOrder",
  "visitRecoveryRecords",
  "range",
  "shadowRuleConditions",
  "situationDecisionRows",
  "displayValidationRows",
  "before",
  "putCandidate",
  "operationCounts",
  "pairSwitchBlocker",
  "interruptPending",
  "saveCandles",
  "candles",
  "addLiquidation",
  "liquidationBuckets",
  "recordLiquidationCoverage",
  "liquidationCoverage",
  "pruneLiquidations",
  "recordAnalysis",
  "maintainRetentionChunk",
  "partyRecords",
  "refreshParty",
  "appendNarrationEntry",
  "narrationState",
  "setNarrationState",
  "commitNarration",
  "narrationCounts",
  "narrationEntries",
  "maintainNarrationRetentionChunk",
  "commitFill",
  "updateSettings",
] as const satisfies readonly (keyof BotDatabase)[];

export class BotDatabase {
  static methodTimingSink:
    | ((method: string, durationMs: number) => void)
    | undefined;

  private timeMethods(sink: NonNullable<typeof BotDatabase.methodTimingSink>) {
    for (const name of timedMethods) {
      const method = this[name];
      Object.defineProperty(this, name, {
        configurable: true,
        writable: true,
        value(this: BotDatabase, ...args: unknown[]) {
          const start = performance.now();
          try {
            return Reflect.apply(method, this, args);
          } finally {
            try {
              sink(name, performance.now() - start);
            } catch {
              // A recording failure must never affect the database call.
            }
          }
        },
      });
    }
  }

  private runtimeWriteRevision = 0;
  runtimeRevision() {
    return this.runtimeWriteRevision;
  }
  private db: DatabaseSync;
  private fault: { sqliteCode: number | null } | null = null;
  /**
   * Optional detailed-performance sink. Null (the default) disables
   * instrumentation completely: every method then runs its original
   * code path. Installed only by the preflight detailed-metrics
   * preload when the operator explicitly enables it. The sink is
   * invoked synchronously and any error it throws is swallowed here:
   * measurement must never break or alter persistence.
   */
  static perfSink: ((record: SqlitePerfRecord) => void) | null = null;
  private perfErrorCode(error: unknown): number | null {
    const value = (error as { errcode?: unknown } | null)?.errcode;
    return typeof value === "number" && Number.isInteger(value)
      ? value & 255
      : null;
  }
  private perfDraft(
    op: SqlitePerfRecord["op"],
    startedAt: number,
  ): SqlitePerfRecord {
    return {
      op,
      table: null,
      key: null,
      rows: 0,
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
      jsonMs: null,
      sqlMs: null,
      beginMs: null,
      bodyMs: null,
      commitMs: null,
      rollbackMs: null,
      ok: true,
      errorCode: null,
      cycleId: null,
      cyclePhase: null,
    };
  }
  private perfFinish(draft: SqlitePerfRecord, t0: number) {
    draft.endedAt = Date.now();
    draft.durationMs = performance.now() - t0;
    const sink = BotDatabase.perfSink;
    if (!sink) return;
    try {
      sink(draft);
    } catch {
      // Measurement must never break persistence.
    }
  }
  private lastRuntime?: Runtime;
  health() {
    return {
      healthy: this.fault === null,
      code: this.fault ? "DATABASE_UNAVAILABLE" : null,
      sqliteCode: this.fault?.sqliteCode ?? null,
      requiresRestart: this.fault !== null,
    };
  }
  assertHealthy() {
    if (this.fault) throw new Error("DATABASE_UNAVAILABLE");
  }
  private sql<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      const value = (error as { errcode?: unknown } | null)?.errcode;
      const code =
        typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0 &&
        value <= 0x7fffffff
          ? value
          : null;
      const primary = code === null ? null : code & 255;
      // node:sqlite exposes numeric errcode (code is ERR_SQLITE_ERROR).
      // Only documented BUSY variants are transient. LOCKED concerns this
      // connection/shared cache and is deliberately not treated as BUSY.
      const transient = code !== null && [5, 261, 517, 773].includes(code);
      // Constraint rejection is a business/transaction failure, not connection loss.
      if (primary !== 19 && !transient) this.fault ??= { sqliteCode: primary };
      throw error;
    }
  }
  private prepare(sql: string) {
    const statement = this.sql(() => this.db.prepare(sql));
    return new Proxy(statement, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "get" || property === "all" || property === "run")
          return (...args: unknown[]) =>
            timeSql(() => {
              if (property === "run") this.assertHealthy();
              return this.sql(() => Reflect.apply(value, target, args));
            });
        return value.bind(target);
      },
    });
  }
  private transactionVersion = 0;
  /** Display-only invalidation token. Covers local SQL, rollback and other writers. */
  displayVersion() {
    const row = this.prepare(
      "SELECT total_changes() AS changes, data_version FROM pragma_data_version",
    ).get()!;
    return `${row.changes}:${row.data_version}:${this.transactionVersion}`;
  }
  constructor(path: string) {
    if (BotDatabase.methodTimingSink)
      this.timeMethods(BotDatabase.methodTimingSink);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;",
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS market_candles(timeframe INTEGER NOT NULL,timestamp INTEGER NOT NULL,source TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(timeframe,timestamp,source));CREATE TABLE IF NOT EXISTS bot_runtime_state(key TEXT PRIMARY KEY,json TEXT NOT NULL);`,
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS shadow_daily_budget(day TEXT PRIMARY KEY, calls INTEGER NOT NULL, lastAt INTEGER NOT NULL);",
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS memwal_outbox(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
        source_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        sent_at INTEGER, job_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        UNIQUE(kind, source_id)
      ); CREATE INDEX IF NOT EXISTS memwal_outbox_pending
        ON memwal_outbox(sent_at, attempts, created_at);`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS liquidation_buckets(
        bucket_at INTEGER PRIMARY KEY, long_usd REAL NOT NULL DEFAULT 0,
        short_usd REAL NOT NULL DEFAULT 0, event_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS liquidation_coverage(
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS liquidation_coverage_started
        ON liquidation_coverage(started_at);`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS narration_entries(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        pair TEXT NOT NULL,
        source_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        json TEXT NOT NULL,
        UNIQUE(pair, source_key, kind)
      );
      CREATE INDEX IF NOT EXISTS narration_entries_pair_order
        ON narration_entries(pair, occurred_at, seq);
      CREATE TABLE IF NOT EXISTS narration_state(
        pair TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );`,
    );
    for (const t of eventTables)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,json TEXT NOT NULL);`,
      );
    for (const t of [
      "operation_candidates",
      "operation_events",
      "paper_checks",
      "paper_trades",
      "portfolio_snapshots",
      "validation_events",
      "sui_observations",
    ] as const)
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS ${t}_timestamp ON ${t}(timestamp);`,
      );
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS trade_order_unique ON paper_trades(id);",
    );
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS rpg_party (
        member TEXT PRIMARY KEY, count INTEGER NOT NULL, notifiedLevel INTEGER
      );
      INSERT OR IGNORE INTO rpg_party(member,count)
        SELECT 'shield', (SELECT COUNT(*) FROM operation_candidates WHERE ${shieldRejection("json")})
        WHERE NOT EXISTS (SELECT 1 FROM rpg_party WHERE member = 'shield');
      CREATE TRIGGER IF NOT EXISTS rpg_shield_insert AFTER INSERT ON operation_candidates
        WHEN ${shieldRejection("NEW.json")}
        BEGIN UPDATE rpg_party SET count = count + 1 WHERE member = 'shield'; END;
      CREATE TRIGGER IF NOT EXISTS rpg_shield_update AFTER UPDATE ON operation_candidates
        WHEN (${shieldRejection("NEW.json")}) AND NOT COALESCE((${shieldRejection("OLD.json")}), 0)
        BEGIN UPDATE rpg_party SET count = count + 1 WHERE member = 'shield'; END;
    `));
    if (!this.get("runtime"))
      this.set("runtime", {
        running: false,
        emergency: false,
        error: null,
        lastCandle: null,
      });
    if (!this.get("portfolio")) this.set("portfolio", initialPortfolio());
    if (!this.get("settings")) this.set("settings", defaults);
  }
  get<T>(key: string): T | undefined {
    const row = this.prepare(
      "SELECT json FROM bot_runtime_state WHERE key=?",
    ).get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  set(key: string, value: unknown) {
    // Monotonic within this connection, including repeated identical errors and failed writes.
    if (key === "runtime") this.runtimeWriteRevision++;
    if (!BotDatabase.perfSink) {
      this.prepare(
        "INSERT INTO bot_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
      ).run(key, JSON.stringify(value));
      return;
    }
    const draft = this.perfDraft("set", Date.now()),
      t0 = performance.now();
    draft.table = "bot_runtime_state";
    draft.key = key;
    draft.rows = 1;
    try {
      const j0 = performance.now();
      const json = JSON.stringify(value);
      draft.jsonMs = performance.now() - j0;
      const s0 = performance.now();
      this.prepare(
        "INSERT INTO bot_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
      ).run(key, json);
      draft.sqlMs = performance.now() - s0;
    } catch (error) {
      draft.ok = false;
      draft.errorCode = this.perfErrorCode(error);
      this.perfFinish(draft, t0);
      throw error;
    }
    this.perfFinish(draft, t0);
  }
  runtime(): Runtime {
    // Effective in-memory stop; never claim that the stop was durably persisted.
    if (this.fault)
      return {
        ...(this.lastRuntime ?? { emergency: false, lastCandle: null }),
        running: false,
        error: "DATABASE_UNAVAILABLE",
      };
    this.lastRuntime = this.get<Runtime>("runtime")!;
    return this.lastRuntime;
  }
  portfolio() {
    return this.get<Portfolio>("portfolio")!;
  }
  settings() {
    return settingsSchema.parse(this.get<Settings>("settings"));
  }
  recordProfit(
    report: import("../../profit-guard/src/index.ts").ProfitReport,
    decision?: TradingDecision,
  ) {
    this.transaction(() => {
      this.append(
        "profit_assessments",
        `${report.asOf}:${randomUUID()}`,
        report,
        report.asOf,
      );
      this.set("profitGuard", report);
      if (decision)
        this.set(
          "decision",
          report.allowed
            ? decision
            : {
                ...decision,
                action: "WAIT",
                confidence: 0,
                reason: `ProfitGuard: ${report.reason}`,
              },
        );
    });
  }
  transaction<T>(fn: () => T): T {
    if (!BotDatabase.perfSink) {
      this.assertHealthy();
      this.sql(() => this.db.exec("BEGIN IMMEDIATE"));
      try {
        const result = fn();
        this.sql(() => this.db.exec("COMMIT"));
        return result;
      } catch (error) {
        try {
          // Rollback must remain possible after a statement has latched a fault.
          this.sql(() => this.db.exec("ROLLBACK"));
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "DATABASE_ROLLBACK_FAILED",
          );
        }
        throw error;
      } finally {
        this.transactionVersion++;
      }
    }
    // Instrumented path: identical control flow, with BEGIN / body /
    // COMMIT / ROLLBACK timed as separate segments.
    const draft = this.perfDraft("transaction", Date.now()),
      t0 = performance.now();
    let segment = t0,
      failed = false;
    try {
      this.assertHealthy();
      this.sql(() => this.db.exec("BEGIN IMMEDIATE"));
      draft.beginMs = performance.now() - segment;
      segment = performance.now();
      try {
        const result = fn();
        draft.bodyMs = performance.now() - segment;
        segment = performance.now();
        this.sql(() => this.db.exec("COMMIT"));
        draft.commitMs = performance.now() - segment;
        return result;
      } catch (error) {
        if (draft.bodyMs === null) draft.bodyMs = performance.now() - segment;
        segment = performance.now();
        try {
          // Rollback must remain possible after a statement has latched a fault.
          this.sql(() => this.db.exec("ROLLBACK"));
        } catch (rollbackError) {
          draft.rollbackMs = performance.now() - segment;
          throw new AggregateError(
            [error, rollbackError],
            "DATABASE_ROLLBACK_FAILED",
          );
        }
        draft.rollbackMs = performance.now() - segment;
        throw error;
      }
    } catch (error) {
      failed = true;
      draft.errorCode = this.perfErrorCode(error);
      throw error;
    } finally {
      this.transactionVersion++;
      draft.ok = !failed;
      this.perfFinish(draft, t0);
    }
  }
  append(table: EventTable, id: string, value: unknown, now = Date.now()) {
    if (!BotDatabase.perfSink) {
      this.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(
        id,
        now,
        JSON.stringify(value),
      );
      return;
    }
    const draft = this.perfDraft("append", Date.now()),
      t0 = performance.now();
    draft.table = table;
    draft.rows = 1;
    if (table === "cycle_audits" && value && typeof value === "object") {
      // Correlation key only: the cycle id/phase the engine itself
      // recorded. No other value content is ever copied to a record.
      const v = value as { cycleId?: unknown; phase?: unknown };
      if (typeof v.cycleId === "string") draft.cycleId = v.cycleId;
      if (typeof v.phase === "string") draft.cyclePhase = v.phase;
    }
    try {
      const j0 = performance.now();
      const json = JSON.stringify(value);
      draft.jsonMs = performance.now() - j0;
      const s0 = performance.now();
      this.prepare(`INSERT INTO ${table} VALUES(?,?,?)`).run(id, now, json);
      draft.sqlMs = performance.now() - s0;
    } catch (error) {
      draft.ok = false;
      draft.errorCode = this.perfErrorCode(error);
      this.perfFinish(draft, t0);
      throw error;
    }
    this.perfFinish(draft, t0);
  }
  enqueueMemwal(
    kind: MemwalEpisodeKind,
    text: string,
    sourceId: string,
    now = Date.now(),
  ) {
    this.prepare(
      `INSERT INTO memwal_outbox(id,kind,text,source_id,created_at)
       VALUES(?,?,?,?,?) ON CONFLICT(kind,source_id) DO NOTHING`,
    ).run(randomUUID(), kind, text, sourceId, now);
  }
  memwalPending(now = Date.now(), limit = 20): MemwalOutboxRow[] {
    return this.prepare(
      `SELECT id,kind,text,source_id AS sourceId,created_at AS createdAt,
              sent_at AS sentAt,job_id AS jobId,attempts
       FROM memwal_outbox
       WHERE sent_at IS NULL
         AND created_at + MIN(3600000, 5000 * (1 << MIN(attempts, 8))) <= ?
       ORDER BY created_at,id LIMIT ?`,
    ).all(now, limit) as unknown as MemwalOutboxRow[];
  }
  memwalSent(id: string, jobId: string, now = Date.now()) {
    this.prepare(
      "UPDATE memwal_outbox SET sent_at=?,job_id=? WHERE id=? AND sent_at IS NULL",
    ).run(now, jobId, id);
  }
  memwalFailed(id: string) {
    this.prepare(
      "UPDATE memwal_outbox SET attempts=attempts+1 WHERE id=? AND sent_at IS NULL",
    ).run(id);
  }
  memwalStatus(): { pending: number; lastSuccessAt: number | null } {
    return this.prepare(
      `SELECT COALESCE(SUM(CASE WHEN sent_at IS NULL THEN 1 ELSE 0 END),0) AS pending,
              MAX(sent_at) AS lastSuccessAt FROM memwal_outbox`,
    ).get() as { pending: number; lastSuccessAt: number | null };
  }
  /** Shadow-only durable reservation, before invocation; crashes consume budget.
   * No strategy/portfolio/runtime rows or analysis transaction are touched. */
  reserveShadowCall(day: string, now: number): boolean {
    const row = this.prepare(
      `INSERT INTO shadow_daily_budget(day,calls,lastAt) VALUES(?,1,?)
      ON CONFLICT(day) DO UPDATE SET calls=calls+1,lastAt=excluded.lastAt
      WHERE calls<200 AND excluded.lastAt-lastAt>=300000 RETURNING calls`,
    ).get(day, now);
    return row !== undefined;
  }
  shadowLastCall(): number | null {
    const row = this.prepare(
      "SELECT MAX(lastAt) AS at FROM shadow_daily_budget",
    ).get() as { at: number | null };
    return row.at;
  }
  shadowLastDecision(): number | null {
    const row = this.prepare(
      "SELECT MAX(timestamp) AS at FROM shadow_decisions",
    ).get() as { at: number | null };
    return row.at;
  }
  history<T = Record<string, unknown>>(table: EventTable, limit = 200): T[] {
    return (
      this.prepare(
        `SELECT json FROM ${table} ORDER BY timestamp DESC,id DESC LIMIT ?`,
      ).all(limit) as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  /** Display-only order history: the SQL column retains the recorded event time
   * even when the order JSON (notably FILLED orders) has no timestamp. */
  orderHistory(limit = 200): Record<string, unknown>[] {
    return (
      this.prepare(
        "SELECT timestamp,json FROM paper_orders ORDER BY timestamp DESC,id DESC LIMIT ?",
      ).all(limit) as { timestamp: number; json: string }[]
    ).map((row) => ({ ...JSON.parse(row.json), timestamp: row.timestamp }));
  }
  hasOrder(id: string) {
    return !!this.prepare("SELECT id FROM paper_orders WHERE id=?").get(id);
  }
  /** Full safety scan, including out-of-window rows. No sorting or history truncation. */
  visitRecoveryRecords(
    visit: (
      table: "paper_orders" | "paper_trades" | "paper_checks",
      row: { id: string; timestamp: number; json: string },
    ) => void,
  ) {
    this.sql(() => {
      for (const table of [
        "paper_orders",
        "paper_trades",
        "paper_checks",
      ] as const) {
        // Keyset batches bound temporary allocations. The caller's recovery proof lock prevents concurrent
        // mutation between batches; the first query has no lower bound (negative rowids included).
        let cursor: number | null = null;
        for (;;) {
          const rows = (
            cursor === null
              ? this.prepare(
                  `SELECT rowid AS scanRowid,id,timestamp,json FROM ${table} ORDER BY rowid LIMIT 1024`,
                ).all()
              : this.prepare(
                  `SELECT rowid AS scanRowid,id,timestamp,json FROM ${table} WHERE rowid>? ORDER BY rowid LIMIT 1024`,
                ).all(cursor)
          ) as {
            scanRowid: number;
            id: string;
            timestamp: number;
            json: string;
          }[];
          for (const row of rows) visit(table, row);
          if (rows.length < 1024) break;
          cursor = rows.at(-1)!.scanRowid;
        }
      }
    });
  }
  range<T>(table: EventTable, from: number, until: number): T[] {
    return (
      this.prepare(
        `SELECT json FROM ${table} WHERE timestamp>=? AND timestamp<=? ORDER BY timestamp,id`,
      ).all(from, until) as { json: string }[]
    ).map((row) => JSON.parse(row.json));
  }
  shadowRuleConditions(
    from: number,
    until: number,
  ): readonly (readonly [string, { evidence?: Record<string, unknown> }])[] {
    return (
      this.prepare(
        "SELECT id,json FROM strategy_decisions WHERE timestamp>=? AND timestamp<=? ORDER BY timestamp,id",
      ).all(from, until) as { id: string; json: string }[]
    ).map((row) => [row.id, JSON.parse(row.json)] as const);
  }
  situationDecisionRows(): { id: string; timestamp: number; decision: TradingDecision }[] {
    return (this.prepare(
      "SELECT id,timestamp,json FROM strategy_decisions ORDER BY timestamp,id",
    ).all() as { id: string; timestamp: number; json: string }[]).map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      decision: JSON.parse(row.json) as TradingDecision,
    }));
  }
  /** Display input cache only; retain SQL timestamps independently of JSON at. */
  displayValidationRows(from: number, until: number) {
    return this.prepare(
      "SELECT timestamp,json FROM validation_events WHERE timestamp>=? AND timestamp<=? ORDER BY timestamp,id",
    ).all(from, until) as { timestamp: number; json: string }[];
  }
  before<T>(table: EventTable, at: number): T | null {
    const row = this.prepare(
      `SELECT json FROM ${table} WHERE timestamp<? ORDER BY timestamp DESC,id DESC LIMIT 1`,
    ).get(at) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  putCandidate(candidate: CandidateAudit) {
    this.prepare(
      "INSERT INTO operation_candidates VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp,json=excluded.json",
    ).run(candidate.id, candidate.timestamp, JSON.stringify(candidate));
  }
  operationCounts(from = 0, until = Number.MAX_SAFE_INTEGER) {
    const row = this.prepare(
      `SELECT COUNT(*) candidates, COALESCE(SUM(json_extract(json,'$.finalAction')='BUY'),0) buys, COALESCE(SUM(json_extract(json,'$.finalAction')='SELL'),0) sells, COALESCE(SUM(json_extract(json,'$.finalAction')='WAIT'),0) waits, COALESCE(SUM(json_extract(json,'$.profitGuard.evaluated')=1 AND json_extract(json,'$.profitGuard.allowed')=0),0) profitRejected, COALESCE(SUM(json_extract(json,'$.risk.status')='REJECTED'),0) riskRejected FROM operation_candidates WHERE timestamp>=? AND timestamp<=?`,
    ).get(from, until) as {
      candidates: number;
      buys: number;
      sells: number;
      waits: number;
      profitRejected: number;
      riskRejected: number;
    };
    const waits = this.prepare(
      "SELECT COUNT(*) n FROM operation_events WHERE timestamp>=? AND timestamp<=? AND json_extract(json,'$.kind')='WAIT'",
    ).get(from, until) as { n: number };
    return { ...row, waits: row.waits + waits.n };
  }
  /** Full-ledger switch gate: never hide holdings or unfinished work in an inactive pair. */
  pairSwitchBlocker():
    "PAIR_POSITION_OPEN" | "PAIR_PENDING_WORK" | "PAIR_INVALID_LEDGER" | null {
    const p = this.portfolio();
    try {
      const quantities = [
        p.sui,
        p.quantityAtomic ?? "0",
        p.costBasis,
        p.costBasisUsdc ?? "0",
      ].map((v) => new Decimal(v));
      if (quantities.some((v) => !v.isFinite() || v.isNegative()))
        return "PAIR_INVALID_LEDGER";
      if (quantities.some((v) => !v.isZero())) return "PAIR_POSITION_OPEN";
    } catch {
      return "PAIR_INVALID_LEDGER";
    }
    const pendingCandidate = this.prepare(
      "SELECT 1 FROM operation_candidates WHERE COALESCE(json_extract(json,'$.finalAction'),'') NOT IN ('BUY','SELL','WAIT','SAFE_STOP') LIMIT 1",
    ).get();
    const pendingOrder = this.prepare(
      "SELECT 1 FROM paper_orders WHERE COALESCE(json_extract(json,'$.status'),'') NOT IN ('FILLED','REJECTED','CANCELLED','EXPIRED') LIMIT 1",
    ).get();
    return pendingCandidate || pendingOrder ? "PAIR_PENDING_WORK" : null;
  }
  interruptPending(now: number) {
    const rows = this.prepare(
      "SELECT json FROM operation_candidates WHERE json_extract(json,'$.finalAction')='PENDING'",
    ).all() as { json: string }[];
    for (const row of rows) {
      const c = JSON.parse(row.json) as CandidateAudit;
      this.putCandidate({
        ...c,
        timestamp: now,
        finalAction: "SAFE_STOP",
        reasons: ["PROCESS_RESTART_INTERRUPTED"],
      });
    }
  }
  saveCandles(c: Candle[]) {
    if (!BotDatabase.perfSink) {
      this.transaction(() => {
        const st = this.prepare(
          "INSERT INTO market_candles VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET json=excluded.json",
        );
        for (const x of c)
          st.run(x.timeframe, x.timestamp, x.source, JSON.stringify(x));
      });
      return;
    }
    // Instrumented path: identical statements and values; the per-row
    // JSON.stringify time and statement execution time are accumulated
    // separately so a slow saveCandles can be attributed to conversion
    // vs SQLite execution (the enclosing transaction is timed as well).
    const draft = this.perfDraft("saveCandles", Date.now()),
      t0 = performance.now();
    draft.table = "market_candles";
    draft.rows = c.length;
    let jsonMs = 0,
      sqlMs = 0;
    try {
      this.transaction(() => {
        const st = this.prepare(
          "INSERT INTO market_candles VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET json=excluded.json",
        );
        for (const x of c) {
          const j0 = performance.now();
          const json = JSON.stringify(x);
          jsonMs += performance.now() - j0;
          const s0 = performance.now();
          st.run(x.timeframe, x.timestamp, x.source, json);
          sqlMs += performance.now() - s0;
        }
      });
    } catch (error) {
      draft.ok = false;
      draft.errorCode = this.perfErrorCode(error);
      draft.jsonMs = jsonMs;
      draft.sqlMs = sqlMs;
      this.perfFinish(draft, t0);
      throw error;
    }
    draft.jsonMs = jsonMs;
    draft.sqlMs = sqlMs;
    this.perfFinish(draft, t0);
  }
  candles(timeframe = 300): Candle[] {
    return (
      this.prepare(
        "SELECT json FROM market_candles WHERE timeframe=? AND source=(SELECT source FROM market_candles WHERE timeframe=? ORDER BY timestamp DESC, rowid DESC LIMIT 1) ORDER BY timestamp DESC LIMIT 1000",
      ).all(timeframe, timeframe) as { json: string }[]
    )
      .map((x) => JSON.parse(x.json))
      .reverse();
  }
  addLiquidation(input: {
    timestamp: number;
    side: "long" | "short";
    notionalUsd: number;
  }) {
    const bucketAt = Math.floor(input.timestamp / 300_000) * 300;
    this.prepare(
      `INSERT INTO liquidation_buckets(bucket_at,long_usd,short_usd,event_count,updated_at)
       VALUES(?,?,?,?,?) ON CONFLICT(bucket_at) DO UPDATE SET
       long_usd=long_usd+excluded.long_usd,
       short_usd=short_usd+excluded.short_usd,
       event_count=event_count+1,updated_at=excluded.updated_at`,
    ).run(bucketAt, input.side === "long" ? input.notionalUsd : 0,
      input.side === "short" ? input.notionalUsd : 0, 1, input.timestamp);
  }
  liquidationBuckets(sinceSeconds = 0): {
    bucketAt: number; longUsd: number; shortUsd: number; count: number;
  }[] {
    return this.prepare(
      `SELECT bucket_at AS bucketAt,long_usd AS longUsd,short_usd AS shortUsd,
              event_count AS count FROM liquidation_buckets
       WHERE bucket_at>=? ORDER BY bucket_at`,
    ).all(sinceSeconds) as ReturnType<BotDatabase["liquidationBuckets"]>;
  }
  recordLiquidationCoverage(kind: "connected" | "gap", startedAt: number, endedAt: number) {
    if (endedAt <= startedAt) return;
    this.prepare("INSERT INTO liquidation_coverage(kind,started_at,ended_at) VALUES(?,?,?)")
      .run(kind, startedAt, endedAt);
  }
  liquidationCoverage(since = 0): {
    kind: "connected" | "gap"; startedAt: number; endedAt: number;
  }[] {
    return this.prepare(
      `SELECT kind,started_at AS startedAt,ended_at AS endedAt
       FROM liquidation_coverage WHERE ended_at>? ORDER BY started_at`,
    ).all(since) as ReturnType<BotDatabase["liquidationCoverage"]>;
  }
  pruneLiquidations(now = Date.now()) {
    const cutoff = now - LIQUIDATION_RETENTION_DAYS * 86_400_000;
    this.transaction(() => {
      this.prepare("DELETE FROM liquidation_buckets WHERE bucket_at<?")
        .run(Math.floor(cutoff / 1000));
      this.prepare("DELETE FROM liquidation_coverage WHERE ended_at<?").run(cutoff);
    });
  }
  recordAnalysis(
    id: string,
    decision: TradingDecision,
    indicators: Indicators,
    now: number,
  ) {
    this.transaction(() => {
      this.append("strategy_decisions", id, decision, now);
      this.append("technical_indicators", id, indicators, now);
      this.set("decision", decision);
      this.set("indicators", indicators);
    });
  }
  /**
   * Rewrites a bounded number of old diagnostic payloads without deleting
   * rows. This is called between trading cycles; the small transaction keeps
   * retention work from becoming an unbounded cycle delay.
   */
  maintainRetentionChunk(now = Date.now()) {
    const cutoff = now - RETENTION_FULL_EVIDENCE_DAYS * 24 * 60 * 60 * 1000;
    const eligible = (table: "strategy_decisions" | "cycle_audits") =>
      this.prepare(
        `SELECT id,json FROM ${table}
         WHERE timestamp<?
           AND CASE WHEN json_valid(json) THEN json_extract(json,'$._retention') END IS NULL
         ORDER BY timestamp,id LIMIT ?`,
      ).all(cutoff, RETENTION_CHUNK_ROWS) as RetentionRow[];
    const decisions = eligible("strategy_decisions");
    const audits = eligible("cycle_audits");
    if (decisions.length === 0 && audits.length === 0) return 0;
    this.transaction(() => {
      for (const { id, json } of decisions)
        this.prepare("UPDATE strategy_decisions SET json=? WHERE id=?").run(
          JSON.stringify(compactDecision(JSON.parse(json))),
          id,
        );
      for (const { id, json } of audits)
        this.prepare("UPDATE cycle_audits SET json=? WHERE id=?").run(
          JSON.stringify(compactCycleAudit(JSON.parse(json))),
          id,
        );
    });
    return decisions.length + audits.length;
  }
  partyRecords(): PartyRecord[] {
    return this.prepare(
      "SELECT member,count,notifiedLevel FROM rpg_party WHERE notifiedLevel IS NOT NULL",
    ).all() as PartyRecord[];
  }

  refreshParty(forecastCount: number, shadowVersion: string) {
    return this.transaction(() => {
      const counts = this.prepare(
        `SELECT
           (SELECT COUNT(*) FROM paper_trades
            WHERE json_type(json,'$.pnl') IN ('integer','real')
              AND ABS(json_extract(json,'$.pnl')) <= 1.7976931348623157e308) AS hero,
           (SELECT count FROM rpg_party WHERE member = 'shield') AS shield,
           ? AS forecast,
           (SELECT COUNT(*) FROM shadow_decisions AS shadow
            JOIN strategy_decisions AS rule ON rule.id = shadow.id
            WHERE json_extract(shadow.json,'$.promptVersion') = ?
              AND json_extract(shadow.json,'$.status') = 'OK'
              AND json_extract(shadow.json,'$.action') IN ('BUY','WAIT')
              AND json_type(shadow.json,'$.candleTimestamp') = 'integer'
              AND json_extract(shadow.json,'$.candleTimestamp') = json_extract(rule.json,'$.evidence.candleTimestamp')
              AND json_type(shadow.json,'$.price') IN ('integer','real')
              AND json_extract(shadow.json,'$.price') > 0
              AND json_extract(shadow.json,'$.price') <= 1.7976931348623157e308) AS shadow`,
      ).get(forecastCount, shadowVersion) as Record<PartyMember, number>;
      const save = this.prepare(
        `INSERT INTO rpg_party(member,count,notifiedLevel) VALUES(?,?,?)
         ON CONFLICT(member) DO UPDATE SET count = MAX(count,excluded.count),
           notifiedLevel = COALESCE(notifiedLevel,excluded.notifiedLevel)
         WHERE excluded.count > count OR notifiedLevel IS NULL`,
      );
      for (const member of partyMembers)
        save.run(member, counts[member], partyLevel(member, counts[member]).level);
      return this.partyRecords();
    });
  }

  appendNarrationEntry(input: Omit<NarrationEntry, "seq" | "json"> & { json: unknown }) {
    const result = this.prepare(
      `INSERT INTO narration_entries
       (id,pair,source_key,kind,occurred_at,created_at,json)
       VALUES(?,?,?,?,?,?,?)`,
    ).run(input.id, input.pair, input.sourceKey, input.kind, input.occurredAt,
      input.createdAt, JSON.stringify(input.json));
    return Number(result.lastInsertRowid);
  }
  narrationState(pair: string): NarrationState | null {
    const row = this.prepare(
      `SELECT pair,version,updated_at AS updatedAt,json
       FROM narration_state WHERE pair=?`,
    ).get(pair) as (Omit<NarrationState, "json"> & { json: string }) | undefined;
    return row ? { ...row, json: JSON.parse(row.json) } : null;
  }
  setNarrationState(state: NarrationState) {
    this.prepare(
      `INSERT INTO narration_state(pair,version,updated_at,json) VALUES(?,?,?,?)
       ON CONFLICT(pair) DO UPDATE SET version=excluded.version,
       updated_at=excluded.updated_at,json=excluded.json`,
    ).run(state.pair, state.version, state.updatedAt, JSON.stringify(state.json));
  }
  commitNarration(
    entries: (Omit<NarrationEntry, "seq" | "json"> & { json: unknown })[],
    state: NarrationState,
    memwalEntries: {
      text: string;
      sourceId: string;
      createdAt: number;
    }[] = [],
    partyLevels: readonly { member: PartyMember; level: number }[] = [],
  ) {
    this.transaction(() => {
      for (const { member, level } of partyLevels)
        this.prepare(
          "UPDATE rpg_party SET notifiedLevel = MAX(notifiedLevel, ?) WHERE member = ?",
        ).run(level, member);
      for (const entry of entries)
        this.prepare(
          `INSERT INTO narration_entries
           (id,pair,source_key,kind,occurred_at,created_at,json)
           VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        ).run(entry.id, entry.pair, entry.sourceKey, entry.kind,
          entry.occurredAt, entry.createdAt, JSON.stringify(entry.json));
      this.setNarrationState(state);
      for (const entry of memwalEntries)
        this.enqueueMemwal(
          "narration",
          entry.text,
          entry.sourceId,
          entry.createdAt,
        );
    });
  }
  narrationCounts(pair: string): Record<string, number> {
    const rows = this.prepare(
      `SELECT kind,COUNT(*) AS count FROM narration_entries
       WHERE pair=? GROUP BY kind ORDER BY kind`,
    ).all(pair) as { kind: string; count: number }[];
    return Object.fromEntries(rows.map((row) => [row.kind, row.count]));
  }
  narrationEntries(pair: string, since?: number, limit = 100) {
    const oldest = this.prepare(
      "SELECT MIN(seq) AS seq FROM narration_entries WHERE pair=?",
    ).get(pair) as { seq: number | null };
    const oldestAvailable = oldest.seq;
    if (since !== undefined && oldestAvailable !== null && since < oldestAvailable - 1)
      return { expired: true as const, oldestAvailable, entries: [] };
    const rows = (since === undefined
      ? this.prepare(
          `SELECT * FROM (
             SELECT seq,id,pair,source_key AS sourceKey,kind,
                    occurred_at AS occurredAt,created_at AS createdAt,json
             FROM narration_entries WHERE pair=?
             ORDER BY occurred_at DESC,seq DESC LIMIT 30
           ) ORDER BY occurredAt ASC,seq ASC`,
        ).all(pair)
      : this.prepare(
          `SELECT seq,id,pair,source_key AS sourceKey,kind,
                  occurred_at AS occurredAt,created_at AS createdAt,json
           FROM narration_entries WHERE pair=? AND seq>?
           ORDER BY occurred_at ASC,seq ASC LIMIT ?`,
        ).all(pair, since, limit + 1)) as (Omit<NarrationEntry, "json"> & {
      json: string;
    })[];
    const hasMore = since !== undefined && rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      expired: false as const,
      oldestAvailable,
      hasMore,
      entries: page.map((row) => ({ ...row, json: JSON.parse(row.json) })),
    };
  }
  maintainNarrationRetentionChunk(pair: string, now = Date.now()) {
    const cutoff = now - NARRATION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const countBoundary = this.prepare(
      `SELECT seq FROM narration_entries WHERE pair=?
       ORDER BY seq DESC LIMIT 1 OFFSET ?`,
    ).get(pair, NARRATION_RETENTION_ROWS - 1) as { seq: number } | undefined;
    const rows = this.prepare(
      `SELECT seq FROM narration_entries
       WHERE pair=? AND (occurred_at<? OR (? IS NOT NULL AND seq<?))
       ORDER BY seq ASC LIMIT ?`,
    ).all(pair, cutoff, countBoundary?.seq ?? null, countBoundary?.seq ?? null,
      NARRATION_RETENTION_CHUNK_ROWS) as { seq: number }[];
    if (rows.length === 0) return 0;
    this.transaction(() => {
      const remove = this.prepare("DELETE FROM narration_entries WHERE seq=?");
      for (const row of rows) remove.run(row.seq);
    });
    return rows.length;
  }
  commitFill(
    id: string,
    order: unknown,
    portfolio: Portfolio,
    trade: Fill,
    runtime: Runtime,
    verification?: {
      audit: CandidateAudit;
      check: AccountingCheck;
      markPrice: number;
      validation?: unknown;
    },
  ) {
    this.transaction(() => {
      if (this.hasOrder(id)) throw new Error("DUPLICATE_ORDER");
      if (this.prepare("SELECT id FROM paper_trades WHERE id=?").get(id))
        throw new Error("DUPLICATE_ORDER");
      if (verification && !verification.check.ok)
        throw new Error("PAPER_RECONCILIATION_FAILED");
      const current = this.runtime();
      if (!current.running || current.emergency || current.error)
        throw new Error("BOT_STOPPED");
      this.append("paper_orders", id, order, trade.timestamp);
      this.append("paper_trades", id, trade, trade.timestamp);
      this.set("portfolio", portfolio);
      this.set("runtime", runtime);
      if (verification?.validation)
        this.append(
          "validation_events",
          `fill:${id}`,
          verification.validation,
          trade.timestamp,
        );
      if (verification) {
        this.putCandidate(verification.audit);
        this.append("paper_checks", id, verification.check, trade.timestamp);
        this.append(
          "portfolio_snapshots",
          `valuation:${id}`,
          {
            timestamp: trade.timestamp,
            equity: portfolio.usdc + portfolio.sui * verification.markPrice,
            realized: portfolio.realized,
            unrealized:
              portfolio.sui * verification.markPrice - portfolio.costBasis,
            fees: portfolio.fees,
          },
          trade.timestamp,
        );
      }
    });
  }
  updateSettings(s: Settings, now = Date.now()) {
    this.transaction(() => {
      this.set("settings", s);
      this.append("bot_settings", `${now}:${randomUUID()}`, s, now);
    });
  }
  close() {
    this.db.close();
  }
}
