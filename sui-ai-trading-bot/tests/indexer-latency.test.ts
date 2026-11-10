import { afterEach, expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import type { IndexerLatencyAggregate } from "../packages/shared/src/operations.ts";

const databases: BotDatabase[] = [];
function setup() {
  const db = new BotDatabase(":memory:");
  databases.push(db);
  return { db, monitor: new OperationMonitor(db) };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it("merges drained samples into a persisted aggregate", () => {
  const { db, monitor } = setup();
  monitor.recordIndexerLatencySamples({
    candles: [100, 300, 200],
    book: [50],
  });
  monitor.recordIndexerLatencySamples({ candles: [400] });
  const aggregate = monitor.state().indexerLatency;
  expect(aggregate?.candles.count).toBe(4);
  expect(aggregate?.candles.maxMs).toBe(400);
  expect(aggregate?.book.count).toBe(1);
  expect(aggregate?.status.count).toBe(0);
  expect(monitor.indexerLatencySummary()).toEqual({
    candles: { count: 4, medianMs: 300, maxMs: 400 },
    book: { count: 1, medianMs: 50, maxMs: 50 },
    status: null,
    other: null,
  });
  // The aggregate lives in operation_state, so a monitor
  // rebuilt on the same database (a process restart) sees it.
  const restarted = new OperationMonitor(db);
  expect(restarted.state().indexerLatency?.candles.count).toBe(4);
  expect(
    db.get<{ indexerLatency: IndexerLatencyAggregate }>("operation_state")
      ?.indexerLatency.candles.count,
  ).toBe(4);
});

it("keeps the recent window bounded while counts keep growing", () => {
  const { monitor } = setup();
  monitor.recordIndexerLatencySamples({
    candles: Array.from({ length: 250 }, (_, i) => i + 1),
  });
  const aggregate = monitor.state().indexerLatency;
  expect(aggregate?.candles.count).toBe(250);
  expect(aggregate?.candles.recent).toHaveLength(60);
  expect(aggregate?.candles.recent[0]).toBe(191);
  expect(aggregate?.candles.maxMs).toBe(250);
});

it("ignores empty and invalid samples without writing state", () => {
  const { monitor } = setup();
  monitor.recordIndexerLatencySamples({});
  monitor.recordIndexerLatencySamples({ candles: [] });
  monitor.recordIndexerLatencySamples({
    candles: [Number.NaN, -1, Number.POSITIVE_INFINITY],
  });
  expect(monitor.state().indexerLatency).toBeNull();
  expect(monitor.indexerLatencySummary()).toEqual({
    candles: null,
    book: null,
    status: null,
    other: null,
  });
});
