import { monitorEventLoopDelay } from "node:perf_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
/**
 * Detailed performance metrics for bottleneck identification.
 *
 * Opt-in only: installed by scripts/preflight-metrics-preload.mjs when
 * SUIBA_PERF_DETAIL=1. Nothing here runs in a normal boot. The module
 * reuses the existing passive-metrics installation point (a preload
 * wrapping BotDatabase) instead of adding a second monitoring system:
 * per-operation SQLite records come from the optional BotDatabase
 * perf sink (JSON / SQL / BEGIN / body / COMMIT phases already split
 * by the database layer), and event-loop delay uses the standard
 * perf_hooks histograms - one cumulative, one windowed for spikes.
 *
 * Design rules:
 *  - No additional RPC, no DB writes of its own, no schema changes.
 *  - Records carry timing metadata only. SQL text, parameters and
 *    stored values are never recorded (the database layer guarantees
 *    this; the sink adds only a method-name context and the current
 *    cycle id, both correlation keys rather than content).
 *  - Output is buffered and flushed in batches to JSONL files; a
 *    failed flush is counted and reported in the final status, never
 *    thrown into a persistence operation. Record count and file size
 *    are capped; drops are counted and flagged as truncation so a
 *    partial file is never mistaken for a complete one.
 *  - A spike record states WHEN the event loop was delayed and what
 *    was recorded at the same time. Time coincidence is evidence for
 *    correlation, not proof of causation; this module never labels a
 *    cause.
 */
const CONTEXT_METHODS = [
  "saveCandles",
  "recordAnalysis",
  "commitFill",
  "recordProfit",
  "updateSettings",
];
const round3 = (value) => Math.round(value * 1000) / 1000;

export function createBufferedJsonlWriter(path, options = {}) {
  const flushIntervalMs = options.flushIntervalMs ?? 2000;
  const flushBatchRecords = options.flushBatchRecords ?? 200;
  const maxRecords = options.maxRecords ?? 60000;
  const maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
  let queue = [],
    stopped = false,
    written = 0,
    dropped = 0,
    bytesWritten = 0,
    flushCount = 0,
    flushFailures = 0,
    flushTotalMs = 0,
    flushMaxMs = 0,
    truncated = false;
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Surfaced as flush failures in stats; never thrown at callers.
  }
  const writer = {
    onFlush: null,
    push(record) {
      // Records are queued as objects and serialized at flush time,
      // keeping JSON.stringify cost off the measured operation path
      // (the flush itself is recorded as sync-io evidence instead).
      if (stopped) {
        dropped++;
        return false;
      }
      if (written + queue.length >= maxRecords) {
        truncated = true;
        dropped++;
        return false;
      }
      queue.push(record);
      if (queue.length >= flushBatchRecords) writer.flush();
      return true;
    },
    flush() {
      if (!queue.length) return;
      const batch = queue;
      queue = [];
      const lines = [];
      let bytes = 0,
        kept = 0;
      for (let i = 0; i < batch.length; i++) {
        let line;
        try {
          line = JSON.stringify(batch[i]);
        } catch {
          dropped++;
          continue;
        }
        const size = Buffer.byteLength(line) + 1;
        if (bytesWritten + bytes + size > maxBytes) {
          truncated = true;
          dropped += batch.length - i;
          break;
        }
        lines.push(line);
        bytes += size;
        kept++;
      }
      const t0 = performance.now();
      let ok = true;
      if (lines.length) {
        try {
          appendFileSync(path, lines.join("\n") + "\n");
          written += kept;
          bytesWritten += bytes;
          flushCount++;
        } catch {
          ok = false;
          flushFailures++;
          dropped += kept;
        }
      }
      const durationMs = performance.now() - t0;
      flushTotalMs += durationMs;
      if (durationMs > flushMaxMs) flushMaxMs = durationMs;
      if (typeof writer.onFlush === "function") {
        try {
          writer.onFlush({
            file: basename(path),
            records: kept,
            bytes,
            startedAt: Date.now() - durationMs,
            endedAt: Date.now(),
            durationMs,
            ok,
          });
        } catch {
          // A flush observer must never break the writer.
        }
      }
    },
    stats() {
      return {
        file: basename(path),
        written,
        dropped,
        bytesWritten,
        flushCount,
        flushFailures,
        flushTotalMs: round3(flushTotalMs),
        flushMaxMs: round3(flushMaxMs),
        truncated,
        queued: queue.length,
      };
    },
    stop() {
      if (stopped) return writer.stats();
      stopped = true;
      clearInterval(timer);
      writer.flush();
      return writer.stats();
    },
  };
  const timer = setInterval(() => writer.flush(), flushIntervalMs);
  timer.unref();
  return writer;
}

export function installDetailedMetrics(options = {}) {
  const {
    databaseClass,
    sqliteWriter,
    spikeWriter,
    eventLoopThresholdMs = 500,
    eventLoopWindowMs = 1000,
  } = options;
  if (
    !databaseClass ||
    typeof databaseClass !== "function" ||
    !databaseClass.prototype ||
    !sqliteWriter ||
    typeof sqliteWriter.push !== "function" ||
    typeof sqliteWriter.stop !== "function" ||
    !spikeWriter ||
    typeof spikeWriter.push !== "function" ||
    typeof spikeWriter.stop !== "function"
  )
    throw Error("INVALID_DETAILED_METRICS_TARGET");
  if (databaseClass.perfSink) throw Error("DETAILED_METRICS_ALREADY_INSTALLED");
  const startedAt = Date.now();
  let stopped = false,
    currentCycleId = null,
    spikesDetected = 0,
    sinkErrors = 0,
    syncIoGuard = false;
  const contextStack = [],
    originals = new Map(),
    wrapped = new Map();
  for (const name of CONTEXT_METHODS) {
    const original = databaseClass.prototype[name];
    if (typeof original !== "function") continue;
    originals.set(name, original);
    const wrapper = function (...args) {
      contextStack.push(name);
      try {
        return Reflect.apply(original, this, args);
      } finally {
        contextStack.pop();
      }
    };
    wrapped.set(name, wrapper);
    databaseClass.prototype[name] = wrapper;
  }
  const onFlush = (info) => {
    if (syncIoGuard || stopped) return;
    syncIoGuard = true;
    try {
      spikeWriter.push({
        v: 1,
        kind: "sync-io",
        source: "perf-detail-writer",
        file: info.file,
        records: info.records,
        bytes: info.bytes,
        startedAt: Math.round(info.startedAt),
        endedAt: Math.round(info.endedAt),
        durationMs: round3(info.durationMs),
        ok: info.ok,
        cycleId: currentCycleId,
      });
    } catch {
      // Sync-IO evidence is best-effort; never break a flush.
    } finally {
      syncIoGuard = false;
    }
  };
  sqliteWriter.onFlush = onFlush;
  spikeWriter.onFlush = onFlush;
  const sink = (record) => {
    if (stopped) return;
    try {
      const out = {
        v: 1,
        kind: "sqlite",
        ...record,
        durationMs: round3(record.durationMs),
        jsonMs: record.jsonMs === null ? null : round3(record.jsonMs),
        sqlMs: record.sqlMs === null ? null : round3(record.sqlMs),
        beginMs: record.beginMs === null ? null : round3(record.beginMs),
        bodyMs: record.bodyMs === null ? null : round3(record.bodyMs),
        commitMs: record.commitMs === null ? null : round3(record.commitMs),
        rollbackMs:
          record.rollbackMs === null ? null : round3(record.rollbackMs),
        context: contextStack.length
          ? contextStack[contextStack.length - 1]
          : null,
        cycleId: record.cycleId ?? currentCycleId,
      };
      if (
        record.op === "append" &&
        record.table === "cycle_audits" &&
        record.cycleId
      ) {
        if (record.cyclePhase === "START") currentCycleId = record.cycleId;
        else if (
          record.cyclePhase === "END" &&
          currentCycleId === record.cycleId
        )
          currentCycleId = null;
      }
      sqliteWriter.push(out);
    } catch {
      sinkErrors++;
    }
  };
  databaseClass.perfSink = sink;
  const cumulative = monitorEventLoopDelay({ resolution: 20 });
  cumulative.enable();
  const windowed = monitorEventLoopDelay({ resolution: 20 });
  windowed.enable();
  let windowStart = Date.now(),
    lastReportedMaxMs = 0;
  const windowStats = (h) => ({
    count: h.count,
    p50Ms: h.count ? round3(h.percentile(50) / 1e6) : null,
    p95Ms: h.count ? round3(h.percentile(95) / 1e6) : null,
    p99Ms: h.count ? round3(h.percentile(99) / 1e6) : null,
    maxMs: h.count ? round3(h.max / 1e6) : null,
  });
  const checker = setInterval(() => {
    const end = Date.now(),
      windowMaxMs = windowed.count > 0 ? windowed.max / 1e6 : 0,
      cumulativeMaxMs = cumulative.count > 0 ? cumulative.max / 1e6 : 0,
      // A blocked loop can delay the histogram's own bookkeeping past a
      // window reset, so a new cumulative peak above the threshold is a
      // second, independent trigger. The window bounds then describe
      // when the spike was OBSERVED, which the correlation report
      // states explicitly; the delay value itself is exact.
      newPeak =
        cumulativeMaxMs >= eventLoopThresholdMs &&
        cumulativeMaxMs > lastReportedMaxMs;
    if ((windowed.count > 0 && windowMaxMs >= eventLoopThresholdMs) || newPeak) {
      spikesDetected++;
      const memory = process.memoryUsage(),
        stats = windowStats(windowed.count > 0 ? windowed : cumulative);
      spikeWriter.push({
        v: 1,
        kind: "event-loop-spike",
        startedAt: windowStart,
        endedAt: end,
        windowMs: end - windowStart,
        maxDelayMs: round3(Math.max(windowMaxMs, cumulativeMaxMs)),
        p50Ms: stats.p50Ms,
        p95Ms: stats.p95Ms,
        p99Ms: stats.p99Ms,
        thresholdMs: eventLoopThresholdMs,
        cycleId: currentCycleId,
        memory: {
          rss: memory.rss,
          heapTotal: memory.heapTotal,
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
      });
    }
    if (cumulativeMaxMs > lastReportedMaxMs)
      lastReportedMaxMs = cumulativeMaxMs;
    windowed.reset();
    windowStart = end;
  }, eventLoopWindowMs);
  checker.unref();
  return {
    stop() {
      if (stopped) throw Error("DETAILED_METRICS_CLOSED");
      stopped = true;
      clearInterval(checker);
      const eventLoopCumulative = windowStats(cumulative);
      cumulative.disable();
      windowed.disable();
      if (databaseClass.perfSink === sink) databaseClass.perfSink = null;
      for (const [name, original] of originals)
        if (databaseClass.prototype[name] === wrapped.get(name))
          databaseClass.prototype[name] = original;
      const sqlite = sqliteWriter.stop(),
        spikes = spikeWriter.stop();
      return {
        enabled: true,
        startedAt,
        endedAt: Date.now(),
        eventLoopThresholdMs,
        spikesDetected,
        sinkErrors,
        eventLoopCumulative,
        sqliteWriter: sqlite,
        spikeWriter: spikes,
      };
    },
  };
}
