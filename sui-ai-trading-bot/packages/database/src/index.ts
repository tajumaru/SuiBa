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
const eventTables = [
  "technical_indicators",
  "strategy_decisions",
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
export class BotDatabase {
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
    const database = this;
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "get" || property === "all" || property === "run")
          return (...args: unknown[]) =>
            timeSql(() => {
              if (property === "run") database.assertHealthy();
              return database.sql(() => Reflect.apply(value, target, args));
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
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA foreign_keys=ON;",
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS market_candles(timeframe INTEGER NOT NULL,timestamp INTEGER NOT NULL,source TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(timeframe,timestamp,source));CREATE TABLE IF NOT EXISTS bot_runtime_state(key TEXT PRIMARY KEY,json TEXT NOT NULL);`,
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
  history<T = Record<string, unknown>>(table: EventTable, limit = 200): T[] {
    return (
      this.prepare(
        `SELECT json FROM ${table} ORDER BY timestamp DESC,id DESC LIMIT ?`,
      ).all(limit) as { json: string }[]
    ).map((r) => JSON.parse(r.json));
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
