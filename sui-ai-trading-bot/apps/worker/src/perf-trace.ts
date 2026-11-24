import { appendFile } from "node:fs";
import { join } from "node:path";
import type { MarketTimings } from "../../../packages/market-data/src/market-timing.ts";
import type { ApiTiming } from "../../../packages/shared/src/api-timing.ts";

const sampleMs = 250;
const windowMs = 60_000;
const slowMs = {
  eventLoop: 100,
  state: 500,
  snapshot: 250,
  cycle: 5_000,
  realSubmit: 5_000,
  market: 2_000,
  analysis: 500,
  saveCandles: 250,
  sqlite: 100,
} as const;
const maxQueuedLines = 256;
const maxSqliteBreakdownEntries = 20;

type Metric = keyof typeof slowMs;
type Totals = { count: number; totalMs: number; maxMs: number };
type RealSubmitOutcome = "SUBMITTED" | "REJECTED" | "UNKNOWN" | "ERROR";
type Details = {
  timing?: ApiTiming;
  statusCode?: number;
  completed?: boolean;
  marketStages?: MarketTimings;
  key?: string;
  outcome?: RealSubmitOutcome;
};
type Span = { metric: Metric; startedAt: number; start: number };

function addTiming(map: Map<string, Totals>, key: string, durationMs: number) {
  let stats = map.get(key);
  if (!stats) {
    stats = { count: 0, totalMs: 0, maxMs: 0 };
    map.set(key, stats);
  }
  stats.count++;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
}

function summarizeSqliteBreakdown(map: Map<string, Totals>) {
  return Object.fromEntries(
    [...map]
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          right.count - left.count || leftKey.localeCompare(rightKey),
      )
      .slice(0, maxSqliteBreakdownEntries)
      .map(([key, { count, totalMs, maxMs }]) => [
        key,
        { count, avgMs: totalMs / count, maxMs },
      ]),
  );
}

export function eventLoopDelay(expected: number, actual: number) {
  return Math.max(0, actual - expected);
}

export class PerfTrace {
  private windowStartedAt = Date.now();
  private readonly totals = new Map<string, Totals>();
  private readonly sqlite = new Map<string, Totals>();
  private readonly sqliteSetKeys = new Map<string, Totals>();
  private readonly sqliteAppendTables = new Map<string, Totals>();
  private readonly active = new Set<Span>();
  private readonly lines: string[] = [];
  private writing = false;
  private droppedLines = 0;
  private readonly sampler: ReturnType<typeof setInterval>;
  private readonly reporter: ReturnType<typeof setInterval>;

  constructor(private readonly file: string) {
    let expected = performance.now() + sampleMs;
    this.sampler = setInterval(() => {
      const actual = performance.now();
      // Skip missed ticks and measure each stall once.
      const delay = eventLoopDelay(expected, actual);
      const endedAt = Date.now();
      this.record("eventLoop", delay, endedAt - delay, endedAt);
      expected = actual + sampleMs;
    }, sampleMs).unref();
    this.reporter = setInterval(() => this.report(), windowMs).unref();
  }

  start(
    metric: Exclude<Metric, "eventLoop" | "sqlite" | "realSubmit">,
    marketStages?: MarketTimings,
  ) {
    const finish = this.startSpan(metric);
    return (timing?: ApiTiming, statusCode?: number, completed?: boolean) =>
      finish({
        ...(timing && { timing, statusCode, completed }),
        marketStages,
      });
  }

  startRealSubmit() {
    const finish = this.startSpan("realSubmit");
    return (outcome: RealSubmitOutcome) => finish({ outcome });
  }

  private startSpan(metric: Metric) {
    const span = { metric, startedAt: Date.now(), start: performance.now() };
    this.active.add(span);
    return (details: Details) => {
      const elapsed = performance.now() - span.start;
      this.active.delete(span);
      this.record(metric, elapsed, span.startedAt, Date.now(), undefined, details);
    };
  }

  recordSqlite(method: string, elapsed: number, keyOrTable?: string) {
    const endedAt = Date.now();
    if (typeof keyOrTable === "string") {
      if (method === "set") addTiming(this.sqliteSetKeys, keyOrTable, elapsed);
      if (method === "append") {
        addTiming(this.sqliteAppendTables, keyOrTable, elapsed);
      }
    }
    this.record("sqlite", elapsed, endedAt - elapsed, endedAt, method, {
      key: method === "append" ? undefined : keyOrTable,
    });
  }

  summary(endedAt = Date.now()) {
    const copy = (map: Map<string, Totals>) =>
      Object.fromEntries([...map].map(([key, stats]) => [key, { ...stats }]));
    return {
      startedAt: this.windowStartedAt,
      endedAt,
      metrics: copy(this.totals),
      sqlite: copy(this.sqlite),
      sqliteBreakdown: {
        set: summarizeSqliteBreakdown(this.sqliteSetKeys),
        append: summarizeSqliteBreakdown(this.sqliteAppendTables),
      },
      droppedLines: this.droppedLines,
    };
  }

  private record(
    metric: Metric,
    durationMs: number,
    startedAt: number,
    endedAt: number,
    method?: string,
    details?: Details,
  ) {
    const map = method === undefined ? this.totals : this.sqlite;
    const key = method ?? metric;
    addTiming(map, key, durationMs);
    if (durationMs <= slowMs[metric]) {
      if (metric === "realSubmit") {
        this.enqueue({
          kind: "completed",
          metric,
          startedAt,
          endedAt,
          durationMs,
          ...details,
        });
      }
    } else {
      const active: Pick<Span, "metric" | "startedAt">[] = [];
      for (const { metric, startedAt } of this.active) {
        active.push({ metric, startedAt });
        if (active.length === 16) break;
      }
      this.enqueue({
        kind: "slow",
        metric,
        method,
        startedAt,
        endedAt,
        durationMs,
        ...details,
        active,
      });
    }
  }

  private report() {
    const endedAt = Date.now();
    this.enqueue({ kind: "summary", ...this.summary(endedAt) });
    this.windowStartedAt = endedAt;
    this.totals.clear();
    this.sqlite.clear();
    this.sqliteSetKeys.clear();
    this.sqliteAppendTables.clear();
  }

  private enqueue(record: object) {
    if (this.lines.length >= maxQueuedLines) {
      this.droppedLines++;
      return;
    }
    this.lines.push(JSON.stringify(record) + "\n");
    this.write();
  }

  private write() {
    if (this.writing || this.lines.length === 0) return;
    const batch = this.lines.splice(0);
    this.writing = true;
    appendFile(this.file, batch.join(""), (error) => {
      if (error) this.droppedLines += batch.length;
      this.writing = false;
      this.write();
    });
  }

  stop() {
    clearInterval(this.sampler);
    clearInterval(this.reporter);
  }
}

export function startPerfTrace(
  dataDirectory: string,
  enabled = process.env.SUIBA_PERF_TRACE_ENABLED,
) {
  if (enabled === "1")
    return new PerfTrace(join(dataDirectory, "perf-trace.jsonl"));
}
