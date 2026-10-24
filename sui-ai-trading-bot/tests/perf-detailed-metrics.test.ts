import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  createBufferedJsonlWriter,
  installDetailedMetrics,
} from "../scripts/preflight-detailed-metrics.mjs";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  // Never leak an installed sink into another test.
  BotDatabase.perfSink = null;
});

function memoryWriter() {
  const records: any[] = [];
  const writer: any = {
    records,
    onFlush: null,
    push(record: any) {
      records.push(record);
      return true;
    },
    flush() {},
    stats() {
      return {
        file: "memory.jsonl",
        written: records.length,
        dropped: 0,
        bytesWritten: 0,
        flushCount: 0,
        flushFailures: 0,
        flushTotalMs: 0,
        flushMaxMs: 0,
        truncated: false,
        queued: 0,
      };
    },
    stop() {
      return writer.stats();
    },
  };
  return writer;
}
function fixture() {
  const db = new BotDatabase(":memory:");
  cleanup.push(() => db.close());
  return db;
}
function candle(timestamp: number) {
  return {
    timestamp,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    source: "test",
    timeframe: 300 as const,
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it("records sqlite operations with JSON/SQL phases separated and no value content", () => {
  const db = fixture(),
    sqlite = memoryWriter(),
    spikes = memoryWriter();
  const detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: sqlite,
    spikeWriter: spikes,
  });
  cleanup.push(() => detailed.stop());
  db.append("risk_events", "e1", { note: "TOP-SECRET-VALUE", n: 1 });
  db.set("some_key", { token: "TOP-SECRET-VALUE" });
  const byOp = (op: string) => sqlite.records.find((r: any) => r.op === op);
  const append = byOp("append"),
    set = byOp("set");
  expect(append.table).toBe("risk_events");
  expect(append.rows).toBe(1);
  expect(append.ok).toBe(true);
  expect(append.jsonMs).not.toBeNull();
  expect(append.sqlMs).not.toBeNull();
  expect(append.jsonMs + append.sqlMs).toBeLessThanOrEqual(
    append.durationMs + 1,
  );
  expect(append.startedAt).toBeLessThanOrEqual(append.endedAt);
  expect(set.table).toBe("bot_runtime_state");
  expect(set.key).toBe("some_key");
  const serialized = JSON.stringify(sqlite.records);
  expect(serialized).not.toContain("TOP-SECRET-VALUE");
  expect(serialized).not.toContain("INSERT INTO");
});

it("separates transaction BEGIN/body/COMMIT and stamps composite context", () => {
  const db = fixture(),
    sqlite = memoryWriter(),
    spikes = memoryWriter();
  const detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: sqlite,
    spikeWriter: spikes,
  });
  cleanup.push(() => detailed.stop());
  db.saveCandles([candle(1000), candle(2000), candle(3000)]);
  const save = sqlite.records.find((r: any) => r.op === "saveCandles"),
    tx = sqlite.records.find((r: any) => r.op === "transaction");
  expect(save.rows).toBe(3);
  expect(save.table).toBe("market_candles");
  expect(save.context).toBe("saveCandles");
  expect(save.jsonMs).not.toBeNull();
  expect(save.sqlMs).not.toBeNull();
  expect(tx.context).toBe("saveCandles");
  expect(tx.beginMs).not.toBeNull();
  expect(tx.bodyMs).not.toBeNull();
  expect(tx.commitMs).not.toBeNull();
  expect(tx.rollbackMs).toBeNull();
  // The plain transaction path reports the same split without a context.
  db.transaction(() => db.set("k", 1));
  const plain = sqlite.records.filter((r: any) => r.op === "transaction").at(-1);
  expect(plain.context).toBeNull();
});

it("correlates operations with the in-flight market cycle id", () => {
  const db = fixture(),
    sqlite = memoryWriter(),
    spikes = memoryWriter();
  const detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: sqlite,
    spikeWriter: spikes,
  });
  cleanup.push(() => detailed.stop());
  db.set("before", 1);
  db.append("cycle_audits", "c1", { cycleId: "cycle-42", phase: "START" });
  db.set("during", 2);
  db.append("cycle_audits", "c2", { cycleId: "cycle-42", phase: "END" });
  db.set("after", 3);
  const setRec = (key: string) =>
    sqlite.records.find((r: any) => r.op === "set" && r.key === key);
  expect(setRec("before").cycleId).toBeNull();
  expect(setRec("during").cycleId).toBe("cycle-42");
  expect(setRec("after").cycleId).toBeNull();
  const start = sqlite.records.find(
    (r: any) => r.op === "append" && r.cyclePhase === "START",
  );
  expect(start.cycleId).toBe("cycle-42");
});

it("records failures with the outcome unchanged (fault latching and rollback)", () => {
  const db = fixture(),
    sqlite = memoryWriter(),
    spikes = memoryWriter();
  const detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: sqlite,
    spikeWriter: spikes,
  });
  cleanup.push(() => detailed.stop());
  expect(() =>
    db.transaction(() => {
      throw Error("boom");
    }),
  ).toThrow("boom");
  const tx = sqlite.records.find((r: any) => r.op === "transaction");
  expect(tx.ok).toBe(false);
  expect(tx.rollbackMs).not.toBeNull();
  expect(tx.commitMs).toBeNull();
  // A circular value fails JSON conversion exactly as before; the
  // record shows the failure in the JSON phase with no SQL time.
  const circular: any = {};
  circular.self = circular;
  expect(() => db.append("risk_events", "bad", circular)).toThrow();
  const bad = sqlite.records.find(
    (r: any) => r.op === "append" && r.ok === false,
  );
  expect(bad).toBeDefined();
  expect(bad.sqlMs).toBeNull();
  // Existing safety behavior is untouched: a non-constraint SQL error
  // still latches the database fault.
  expect(() => db.append("missing_table" as never, "x", {})).toThrow();
  expect(db.health().healthy).toBe(false);
  expect(db.health().requiresRestart).toBe(true);
});

it("detects event-loop spikes above the configured threshold with memory", async () => {
  const db = fixture(),
    sqlite = memoryWriter(),
    spikes = memoryWriter();
  const detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: sqlite,
    spikeWriter: spikes,
    eventLoopThresholdMs: 30,
    eventLoopWindowMs: 100,
  });
  cleanup.push(() => detailed.stop());
  // Warm up first: monitorEventLoopDelay only observes delays once
  // its internal timer is cycling (the same shape as production,
  // where the preload installs at boot and blocks happen mid-run).
  await sleep(250);
  const until = Date.now() + 160;
  while (Date.now() < until) {
    // Deliberate synchronous block: the event loop cannot tick.
  }
  await sleep(500);
  const spike = spikes.records.find((r: any) => r.kind === "event-loop-spike");
  expect(spike).toBeDefined();
  expect(spike.maxDelayMs).toBeGreaterThanOrEqual(30);
  expect(spike.thresholdMs).toBe(30);
  expect(spike.memory.rss).toBeGreaterThan(0);
  expect(spike.endedAt).toBeGreaterThanOrEqual(spike.startedAt);
  const status = detailed.stop();
  cleanup.pop();
  expect(status.spikesDetected).toBeGreaterThanOrEqual(1);
  expect(status.eventLoopCumulative.maxMs).not.toBeNull();
  expect(status.eventLoopCumulative.p95Ms).not.toBeNull();
});

it("records the metrics writer's own flushes as sync-io evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-perf-test-"));
  const sqlite = createBufferedJsonlWriter(join(dir, "sqlite-timing.jsonl"), {
      flushBatchRecords: 2,
      flushIntervalMs: 60000,
    }),
    spikes = createBufferedJsonlWriter(join(dir, "event-loop-spikes.jsonl"), {
      flushBatchRecords: 1000,
      flushIntervalMs: 60000,
    });
  const db = fixture();
  const detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: sqlite,
    spikeWriter: spikes,
  });
  db.append("risk_events", "a", { n: 1 });
  db.append("risk_events", "b", { n: 2 });
  detailed.stop();
  const spikeLines = readFileSync(join(dir, "event-loop-spikes.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const io = spikeLines.find((r: any) => r.kind === "sync-io");
  expect(io).toBeDefined();
  expect(io.source).toBe("perf-detail-writer");
  expect(io.file).toBe("sqlite-timing.jsonl");
  expect(io.ok).toBe(true);
  const sqliteLines = readFileSync(join(dir, "sqlite-timing.jsonl"), "utf8")
    .trim()
    .split("\n");
  expect(sqliteLines.length).toBe(2);
});

it("caps records, flags truncation and counts drops", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-perf-cap-"));
  const writer = createBufferedJsonlWriter(join(dir, "capped.jsonl"), {
    maxRecords: 5,
    flushBatchRecords: 1000,
    flushIntervalMs: 60000,
  });
  for (let i = 0; i < 5; i++) expect(writer.push({ i })).toBe(true);
  expect(writer.push({ i: 5 })).toBe(false);
  expect(writer.push({ i: 6 })).toBe(false);
  const stats = writer.stop();
  expect(stats.written).toBe(5);
  expect(stats.dropped).toBe(2);
  expect(stats.truncated).toBe(true);
  expect(
    readFileSync(join(dir, "capped.jsonl"), "utf8").trim().split("\n"),
  ).toHaveLength(5);
});

it("counts write failures instead of throwing into persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-perf-fail-"));
  const blocker = join(dir, "blocker");
  // A regular file used as a directory makes every append fail.
  writeFileSync(blocker, "not a directory");
  const writer = createBufferedJsonlWriter(join(blocker, "x.jsonl"), {
    flushBatchRecords: 1,
    flushIntervalMs: 60000,
  });
  expect(() => writer.push({ a: 1 })).not.toThrow();
  const stats = writer.stop();
  expect(stats.flushFailures).toBeGreaterThanOrEqual(1);
  expect(stats.written).toBe(0);
  expect(stats.dropped).toBeGreaterThanOrEqual(1);
});

it("drops unserializable records at flush without throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-perf-bad-"));
  const writer = createBufferedJsonlWriter(join(dir, "bad.jsonl"), {
    flushIntervalMs: 60000,
  });
  const circular: any = {};
  circular.self = circular;
  // Serialization is deferred to flush time, so the drop is counted
  // there; the caller path never throws either way.
  expect(() => writer.push(circular)).not.toThrow();
  expect(writer.push({ ok: 1 })).toBe(true);
  const stats = writer.stop();
  expect(stats.written).toBe(1);
  expect(stats.dropped).toBe(1);
});

it("OFF by default: no sink, no records, unchanged behavior; sink errors are isolated", () => {
  const db = fixture();
  expect(BotDatabase.perfSink).toBeNull();
  db.append("risk_events", "plain", { n: 1 });
  db.set("k", "v");
  expect(db.get("k")).toBe("v");
  // Even a throwing sink cannot break or alter persistence.
  BotDatabase.perfSink = () => {
    throw Error("sink exploded");
  };
  try {
    db.append("risk_events", "still-ok", { n: 2 });
    db.transaction(() => db.set("k2", 3));
    expect(db.get("k2")).toBe(3);
  } finally {
    BotDatabase.perfSink = null;
  }
});

it("double install is rejected and stop restores the prototype", () => {
  const db = fixture(),
    originalSave = BotDatabase.prototype.saveCandles;
  const detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: memoryWriter(),
    spikeWriter: memoryWriter(),
  });
  expect(BotDatabase.prototype.saveCandles).not.toBe(originalSave);
  expect(() =>
    installDetailedMetrics({
      databaseClass: BotDatabase,
      sqliteWriter: memoryWriter(),
      spikeWriter: memoryWriter(),
    }),
  ).toThrow("DETAILED_METRICS_ALREADY_INSTALLED");
  const status = detailed.stop();
  expect(status.enabled).toBe(true);
  expect(BotDatabase.perfSink).toBeNull();
  expect(BotDatabase.prototype.saveCandles).toBe(originalSave);
  expect(() => detailed.stop()).toThrow("DETAILED_METRICS_CLOSED");
  expect(db.get("missing")).toBeUndefined();
});
