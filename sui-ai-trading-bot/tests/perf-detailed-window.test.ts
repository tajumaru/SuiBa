import { afterEach, expect, it, vi } from "vitest";
import type { BufferedJsonlWriter } from "../scripts/preflight-detailed-metrics.mjs";

const { histograms } = vi.hoisted(() => ({
  histograms: [] as { count: number; max: number }[],
}));
vi.mock("node:perf_hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:perf_hooks")>()),
  monitorEventLoopDelay: () => {
    const histogram = {
      count: 1,
      max: 0,
      enable() {},
      disable() {},
      reset() {
        this.max = 0;
      },
      percentile() {
        return 20e6;
      },
    };
    histograms.push(histogram);
    return histogram;
  },
}));
import { installDetailedMetrics } from "../scripts/preflight-detailed-metrics.mjs";

afterEach(() => {
  histograms.length = 0;
  vi.useRealTimers();
});

it("keeps a later window spike separate from an older cumulative peak", () => {
  vi.useFakeTimers();
  class Database {
    static perfSink = null;
  }
  const records: any[] = [];
  const writer: BufferedJsonlWriter = {
    onFlush: null,
    push(record) {
      records.push(record);
      return true;
    },
    flush() {},
    stats() {
      return {
        file: "memory",
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
      return this.stats();
    },
  };
  const detailed = installDetailedMetrics({
    databaseClass: Database,
    sqliteWriter: writer,
    spikeWriter: writer,
    eventLoopThresholdMs: 500,
  });
  try {
    const [cumulative, windowed] = histograms;
    cumulative.max = windowed.max = 3000e6;
    vi.advanceTimersByTime(1000);
    windowed.max = 600e6;
    vi.advanceTimersByTime(1000);
    expect(records.map((r) => r.maxDelayMs)).toEqual([3000, 600]);
    windowed.max = 20e6;
    vi.advanceTimersByTime(1000);
    expect(records).toHaveLength(2);
    // A genuinely new cumulative peak still triggers if the window missed it.
    cumulative.max = 4000e6;
    vi.advanceTimersByTime(1000);
    expect(records.map((r) => r.maxDelayMs)).toEqual([3000, 600, 4000]);
    expect(records[1].startedAt).toBe(records[0].endedAt);
  } finally {
    detailed.stop();
  }
});
