import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  eventLoopDelay,
  startPerfTrace,
  type PerfTrace,
} from "../apps/worker/src/perf-trace.ts";
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
  const finishMarket = trace.start("market");
  vi.advanceTimersByTime(2_500);
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
