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
] as const;
type EventTable = (typeof eventTables)[number];
export class BotDatabase {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS market_candles(timeframe INTEGER NOT NULL,timestamp INTEGER NOT NULL,source TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(timeframe,timestamp,source));CREATE TABLE IF NOT EXISTS bot_runtime_state(key TEXT PRIMARY KEY,json TEXT NOT NULL);`,
    );
    for (const t of eventTables)
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS ${t}(id TEXT PRIMARY KEY,timestamp INTEGER NOT NULL,json TEXT NOT NULL);`,
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
  ) {
    this.transaction(() => {
      if (this.hasOrder(id)) throw new Error("DUPLICATE_ORDER");
      const current = this.runtime();
      if (!current.running || current.emergency || current.error)
        throw new Error("BOT_STOPPED");
      this.append("paper_orders", id, order, trade.timestamp);
      this.append("paper_trades", id, trade, trade.timestamp);
      this.set("portfolio", portfolio);
      this.set("runtime", runtime);
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
