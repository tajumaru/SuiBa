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
    samples: { candles: [100, 300, 200], book: [50] },
  });
  monitor.recordIndexerLatencySamples({ samples: { candles: [400] } });
  const aggregate = monitor.state().indexerLatency;
  expect(aggregate?.candles.count).toBe(4);
  expect(aggregate?.candles.maxMs).toBe(400);
  expect(aggregate?.book.count).toBe(1);
  expect(aggregate?.status.count).toBe(0);
  expect(monitor.indexerLatencySummary()).toEqual({
    candles: { count: 4, medianMs: 300, maxMs: 400, cached: 0 },
    book: { count: 1, medianMs: 50, maxMs: 50, cached: 0 },
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
    samples: { candles: Array.from({ length: 250 }, (_, i) => i + 1) },
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
  monitor.recordIndexerLatencySamples({ samples: { candles: [] } });
  monitor.recordIndexerLatencySamples({
    samples: { candles: [Number.NaN, -1, Number.POSITIVE_INFINITY] },
  });
  monitor.recordIndexerLatencySamples({
    cached: { candles: -1 },
  });
  monitor.recordIndexerLatencySamples({
    cached: { candles: 1.5 },
  });
  expect(monitor.state().indexerLatency).toBeNull();
  expect(monitor.indexerLatencySummary()).toEqual({
    candles: null,
    book: null,
    status: null,
    other: null,
  });
});

it("counts TTL cache hits apart from the latency distribution", () => {
  const { db, monitor } = setup();
  monitor.recordIndexerLatencySamples({
    samples: { candles: [100, 300] },
    cached: { candles: 5, book: 2 },
  });
  const aggregate = monitor.state().indexerLatency;
  // The hits raise only the cached counter: the distribution
  // (count, max, recent ring, median) sees network reads only.
  expect(aggregate?.candles).toEqual({
    count: 2,
    maxMs: 300,
    recent: [100, 300],
    cached: 5,
  });
  expect(aggregate?.book).toEqual({
    count: 0,
    maxMs: 0,
    recent: [],
    cached: 2,
  });
  expect(monitor.indexerLatencySummary()).toEqual({
    candles: { count: 2, medianMs: 300, maxMs: 300, cached: 5 },
    book: { count: 0, medianMs: null, maxMs: 0, cached: 2 },
    status: null,
    other: null,
  });
  monitor.recordIndexerLatencySamples({ cached: { candles: 3 } });
  expect(monitor.state().indexerLatency?.candles.cached).toBe(8);
  expect(monitor.state().indexerLatency?.candles.count).toBe(2);
  // The cached counter persists across a restart like the rest
  // of the aggregate.
  const restarted = new OperationMonitor(db);
  expect(restarted.state().indexerLatency?.candles.cached).toBe(8);
});

it("treats aggregates persisted before the split as zero cached", () => {
  const { db, monitor } = setup();
  monitor.recordIndexerLatencySamples({
    samples: { candles: [100, 300] },
  });
  // Rewrite the persisted aggregate in the pre-split shape
  // (buckets without a cached field), as an older worker
  // would have left it.
  const state = monitor.state();
  const legacy = structuredClone(state.indexerLatency!);
  for (const kind of ["candles", "book", "status", "other"] as const)
    delete legacy[kind].cached;
  db.set("operation_state", { ...state, indexerLatency: legacy });
  monitor.recordIndexerLatencySamples({
    samples: { candles: [200] },
    cached: { candles: 1 },
  });
  expect(monitor.state().indexerLatency?.candles).toEqual({
    count: 3,
    maxMs: 300,
    recent: [100, 300, 200],
    cached: 1,
  });
  expect(monitor.indexerLatencySummary().candles).toEqual({
    count: 3,
    medianMs: 200,
    maxMs: 300,
    cached: 1,
  });
});
