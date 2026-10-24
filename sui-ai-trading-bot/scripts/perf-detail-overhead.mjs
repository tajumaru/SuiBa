/**
 * Measurement-overhead comparison for the detailed performance
 * metrics: identical synchronous persistence workload with the metrics
 * OFF (default) and ON (real buffered JSONL writers). Because the
 * database runs with synchronous=FULL, single-run wall times are
 * dominated by fsync jitter, so the bench runs several alternating
 * OFF/ON pairs and reports medians.
 *
 * Run with: npx tsx scripts/perf-detail-overhead.mjs
 * This is a standalone bench, not part of the vitest suite.
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  createBufferedJsonlWriter,
  installDetailedMetrics,
} from "./preflight-detailed-metrics.mjs";

const ROUNDS = 1500;
const PAIRS = 5;
function workload(db) {
  for (let i = 0; i < ROUNDS; i++) {
    db.append("risk_events", `e${i}`, { index: i, note: "bench" });
    db.set("bench_key", { index: i });
    db.transaction(() => db.set("bench_tx", { index: i }));
  }
  const candles = Array.from({ length: 60 }, (_, i) => ({
    timestamp: 1000000 + i * 300,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    source: "bench",
    timeframe: 300,
  }));
  for (let i = 0; i < 20; i++) db.saveCandles(candles);
}
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const dir = mkdtempSync(join(tmpdir(), "suiba-perf-bench-"));
const offTimes = [],
  onTimes = [];
let lastStatus = null;
for (let pair = 0; pair < PAIRS; pair++) {
  const offDb = new BotDatabase(join(dir, `off-${pair}.sqlite`));
  let t0 = performance.now();
  workload(offDb);
  offTimes.push(performance.now() - t0);
  offDb.close();
  const onDb = new BotDatabase(join(dir, `on-${pair}.sqlite`));
  const detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: createBufferedJsonlWriter(
      join(dir, `sqlite-timing-${pair}.jsonl`),
    ),
    spikeWriter: createBufferedJsonlWriter(
      join(dir, `event-loop-spikes-${pair}.jsonl`),
    ),
  });
  t0 = performance.now();
  workload(onDb);
  onTimes.push(performance.now() - t0);
  lastStatus = detailed.stop();
  onDb.close();
}
const offMs = median(offTimes),
  onMs = median(onTimes),
  operations = ROUNDS * 3 + 20;
process.stdout.write(
  `${JSON.stringify(
    {
      workload: {
        rounds: ROUNDS,
        saveCandlesBatches: 20,
        candlesPerBatch: 60,
        topLevelOperations: operations,
      },
      pairs: PAIRS,
      offRunsMs: offTimes.map((v) => Math.round(v * 1000) / 1000),
      onRunsMs: onTimes.map((v) => Math.round(v * 1000) / 1000),
      offMedianMs: Math.round(offMs * 1000) / 1000,
      onMedianMs: Math.round(onMs * 1000) / 1000,
      deltaMedianMs: Math.round((onMs - offMs) * 1000) / 1000,
      deltaPercent: Math.round(((onMs - offMs) / offMs) * 10000) / 100,
      perOperationDeltaUs:
        Math.round(((onMs - offMs) / operations) * 10000) / 10,
      lastOnStatus: {
        sqliteWriter: lastStatus.sqliteWriter,
        spikeWriter: lastStatus.spikeWriter,
      },
    },
    null,
    2,
  )}\n`,
);
