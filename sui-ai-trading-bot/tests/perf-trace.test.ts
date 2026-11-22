import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  eventLoopDelay,
  startPerfTrace,
  type PerfTrace,
} from "../apps/worker/src/perf-trace.ts";
import {
  startMarketStage,
  withMarketTiming,
  type MarketTimings,
} from "../packages/market-data/src/market-timing.ts";
import { BotDatabase } from "../packages/database/src/index.ts";

let directory: string;
let trace: PerfTrace | undefined;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "suiba-perf-"));
});
afterEach(() => {
  trace?.stop();
  trace = undefined;
  BotDatabase.methodTimingSink = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

it("counts only lateness from the planned timer tick", () => {
  expect(eventLoopDelay(250, 249)).toBe(0);
  expect(eventLoopDelay(250, 250)).toBe(0);
  expect(eventLoopDelay(250, 750)).toBe(500);
});

it("does not create a trace unless the flag is exactly 1", () => {
  vi.useFakeTimers();
  vi.stubEnv("SUIBA_PERF_TRACE_ENABLED", undefined);
  expect(startPerfTrace(directory)).toBeUndefined();
  expect(startPerfTrace(directory, "true")).toBeUndefined();
  vi.advanceTimersByTime(60_000);
  expect(existsSync(join(directory, "perf-trace.jsonl"))).toBe(false);
});

it("writes a one-minute summary with separate inclusive SQLite method totals", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  vi.stubEnv("SUIBA_PERF_TRACE_ENABLED", "1");
  trace = startPerfTrace(directory)!;
  const file = join(directory, "perf-trace.jsonl");
  expect(existsSync(file)).toBe(false);
  trace.recordSqlite("get", 2);
  trace.recordSqlite("get", 4);
  trace.recordSqlite("set", 7);
  const finishCycle = trace.start("cycle");
  const stages: MarketTimings = {};
  const finishMarket = trace.start("market", stages);
  withMarketTiming(stages, () => {
    const finishHealth = startMarketStage("sui.health");
    vi.advanceTimersByTime(500);
    finishHealth?.();
    for (let i = 0; i < 2; i++) {
      const finishRead = startMarketStage("deepbook.read.minutePages");
      vi.advanceTimersByTime(1_000);
      finishRead?.();
    }
  });
  finishMarket();
  finishCycle();
  vi.advanceTimersByTime(57_500);
  const current = trace.summary();
  const expected = {
    kind: "summary",
    startedAt: 1_000,
    endedAt: 61_000,
    metrics: {
      cycle: { count: 1, totalMs: 2_500, maxMs: 2_500 },
      market: { count: 1, totalMs: 2_500, maxMs: 2_500 },
      eventLoop: {
        count: 240 - (current.metrics.eventLoop?.count ?? 0),
        totalMs: 0,
        maxMs: 0,
      },
    },
    sqlite: {
      get: { count: 2, totalMs: 6, maxMs: 4 },
      set: { count: 1, totalMs: 7, maxMs: 7 },
    },
    droppedLines: 0,
  };
  expect(current).toMatchObject({
    startedAt: 61_000,
    endedAt: 61_000,
    droppedLines: 0,
  });
  expect(current.sqlite).toEqual({});
  expect(current.metrics.cycle).toBeUndefined();
  vi.useRealTimers();
  await vi.waitFor(() => {
    const rows = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toEqual([
      {
        kind: "slow",
        metric: "market",
        startedAt: 1_000,
        endedAt: 3_500,
        durationMs: 2_500,
        marketStages: {
          "sui.health": { count: 1, totalMs: 500, maxMs: 500 },
          "deepbook.read.minutePages": {
            count: 2,
            totalMs: 2_000,
            maxMs: 1_000,
          },
        },
        active: [{ metric: "cycle", startedAt: 1_000 }],
      },
      expected,
    ]);
  });
});

it("times actual database reads, writes and failed calls without changing their result", () => {
  trace = startPerfTrace(directory, "1")!;
  const recorder = trace;
  BotDatabase.methodTimingSink = (method, elapsed) =>
    recorder.recordSqlite(method, elapsed);
  const db = new BotDatabase(":memory:");
  try {
    const before = trace.summary().sqlite;
    db.set("perf_test", { value: 42 });
    expect(db.get("perf_test")).toEqual({ value: 42 });
    expect(() =>
      db.transaction(() => {
        throw new Error("ROLLBACK_TEST");
      }),
    ).toThrow("ROLLBACK_TEST");
    const after = trace.summary().sqlite;
    expect(after.get.count - before.get.count).toBe(1);
    expect(after.set.count - before.set.count).toBe(1);
    expect(after.transaction.count - before.transaction.count).toBe(1);
  } finally {
    db.close();
  }
});

it("includes the runtime key only in slow SQLite set events", async () => {
  vi.useFakeTimers();
  const recorder = (trace = startPerfTrace(directory, "1")!);
  BotDatabase.methodTimingSink = (method, elapsed, key) =>
    recorder.recordSqlite(method, elapsed, key);
  const db = new BotDatabase(":memory:");
  try {
    db.set("fast", true);
    db.set("slow_at_limit", {
      toJSON() {
        vi.advanceTimersByTime(100);
        return "test value";
      },
    });
    db.set("slow_above_limit", {
      toJSON() {
        vi.advanceTimersByTime(101);
        return "test value";
      },
    });
    expect(db.get("slow_above_limit")).toBe("test value");
    expect(recorder.summary().sqlite).not.toHaveProperty("slow_above_limit");
  } finally {
    db.close();
  }
  vi.useRealTimers();
  await vi.waitFor(() => {
    const rows = readFileSync(join(directory, "perf-trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toMatchObject([
      {
        kind: "slow",
        metric: "sqlite",
        method: "set",
        key: "slow_above_limit",
        durationMs: 101,
      },
    ]);
    expect(rows[0]).not.toHaveProperty("value");
  });
});

it("records every REAL submit outcome and includes its duration in the summary", async () => {
  vi.useFakeTimers();
  trace = startPerfTrace(directory, "1")!;
  const attempts = [
    { outcome: "SUBMITTED", durationMs: 5_001, kind: "slow" },
    { outcome: "REJECTED", durationMs: 1, kind: "completed" },
    { outcome: "UNKNOWN", durationMs: 50, kind: "completed" },
    { outcome: "ERROR", durationMs: 10, kind: "completed" },
  ] as const;
  for (const { outcome, durationMs } of attempts) {
    const finish = trace.startRealSubmit();
    vi.advanceTimersByTime(durationMs);
    finish(outcome);
  }
  expect(trace.summary().metrics.realSubmit).toEqual({
    count: 4,
    totalMs: 5_062,
    maxMs: 5_001,
  });

  vi.useRealTimers();
  await vi.waitFor(() => {
    const rows = readFileSync(join(directory, "perf-trace.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toMatchObject(
      attempts.map((attempt) => ({ metric: "realSubmit", ...attempt })),
    );
  });
});
