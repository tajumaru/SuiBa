import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  defaults,
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
] as const;
type EventTable = (typeof eventTables)[number];
export class BotDatabase {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
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
    const row = this.db
      .prepare("SELECT json FROM bot_runtime_state WHERE key=?")
      .get(key) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO bot_runtime_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json",
      )
      .run(key, JSON.stringify(value));
  }
  runtime() {
    return this.get<Runtime>("runtime")!;
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
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  append(table: EventTable, id: string, value: unknown, now = Date.now()) {
    this.db
      .prepare(`INSERT INTO ${table} VALUES(?,?,?)`)
      .run(id, now, JSON.stringify(value));
  }
  history<T = Record<string, unknown>>(table: EventTable, limit = 200): T[] {
    return (
      this.db
        .prepare(
          `SELECT json FROM ${table} ORDER BY timestamp DESC,id DESC LIMIT ?`,
        )
        .all(limit) as { json: string }[]
    ).map((r) => JSON.parse(r.json));
  }
  hasOrder(id: string) {
    return !!this.db.prepare("SELECT id FROM paper_orders WHERE id=?").get(id);
  }
  range<T>(table: EventTable, from: number, until: number): T[] {
    return (
      this.db
        .prepare(
          `SELECT json FROM ${table} WHERE timestamp>=? AND timestamp<=? ORDER BY timestamp,id`,
        )
        .all(from, until) as { json: string }[]
    ).map((row) => JSON.parse(row.json));
  }
  before<T>(table: EventTable, at: number): T | null {
    const row = this.db
      .prepare(
        `SELECT json FROM ${table} WHERE timestamp<? ORDER BY timestamp DESC,id DESC LIMIT 1`,
      )
      .get(at) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }
  putCandidate(candidate: CandidateAudit) {
    this.db
      .prepare(
        "INSERT INTO operation_candidates VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET timestamp=excluded.timestamp,json=excluded.json",
      )
      .run(candidate.id, candidate.timestamp, JSON.stringify(candidate));
  }
  operationCounts(from = 0, until = Number.MAX_SAFE_INTEGER) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) candidates, COALESCE(SUM(json_extract(json,'$.finalAction')='BUY'),0) buys, COALESCE(SUM(json_extract(json,'$.finalAction')='SELL'),0) sells, COALESCE(SUM(json_extract(json,'$.finalAction')='WAIT'),0) waits, COALESCE(SUM(json_extract(json,'$.profitGuard.evaluated')=1 AND json_extract(json,'$.profitGuard.allowed')=0),0) profitRejected, COALESCE(SUM(json_extract(json,'$.risk.status')='REJECTED'),0) riskRejected FROM operation_candidates WHERE timestamp>=? AND timestamp<=?`,
      )
      .get(from, until) as {
      candidates: number;
      buys: number;
      sells: number;
      waits: number;
      profitRejected: number;
      riskRejected: number;
    };
    const waits = this.db
      .prepare(
        "SELECT COUNT(*) n FROM operation_events WHERE timestamp>=? AND timestamp<=? AND json_extract(json,'$.kind')='WAIT'",
      )
      .get(from, until) as { n: number };
    return { ...row, waits: row.waits + waits.n };
  }
  interruptPending(now: number) {
    const rows = this.db
      .prepare(
        "SELECT json FROM operation_candidates WHERE json_extract(json,'$.finalAction')='PENDING'",
      )
      .all() as { json: string }[];
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
    this.transaction(() => {
      const st = this.db.prepare(
        "INSERT INTO market_candles VALUES(?,?,?,?) ON CONFLICT DO UPDATE SET json=excluded.json",
      );
      for (const x of c)
        st.run(x.timeframe, x.timestamp, x.source, JSON.stringify(x));
    });
  }
  candles(timeframe = 300): Candle[] {
    return (
      this.db
        .prepare(
          "SELECT json FROM market_candles WHERE timeframe=? AND source=(SELECT source FROM market_candles WHERE timeframe=? ORDER BY timestamp DESC, rowid DESC LIMIT 1) ORDER BY timestamp DESC LIMIT 1000",
        )
        .all(timeframe, timeframe) as { json: string }[]
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
    },
  ) {
    this.transaction(() => {
      if (this.hasOrder(id)) throw new Error("DUPLICATE_ORDER");
      if (this.db.prepare("SELECT id FROM paper_trades WHERE id=?").get(id))
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
