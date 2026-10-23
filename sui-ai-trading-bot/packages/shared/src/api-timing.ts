import { AsyncLocalStorage } from "node:async_hooks";

export interface ApiTiming {
  sqlCount: number;
  sqlMs: number;
  aggregateMs: number;
  jsonMs: number;
  compressionMs: number;
}
const storage = new AsyncLocalStorage<ApiTiming>();
export const currentApiTiming = () => storage.getStore();
export function withApiTiming<T>(fn: () => T): T {
  return storage.run(
    { sqlCount: 0, sqlMs: 0, aggregateMs: 0, jsonMs: 0, compressionMs: 0 },
    fn,
  );
}
export function timeSql<T>(fn: () => T): T {
  const timing = storage.getStore();
  if (!timing) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    timing.sqlCount++;
    timing.sqlMs += performance.now() - start;
  }
}
/** Exclusive synchronous application aggregation, including JSON.parse but excluding SQL. */
export function timeAggregation<T>(fn: () => T): T {
  const timing = storage.getStore();
  if (!timing) return fn();
  const start = performance.now(),
    sql = timing.sqlMs;
  try {
    return fn();
  } finally {
    timing.aggregateMs += Math.max(
      0,
      performance.now() - start - (timing.sqlMs - sql),
    );
  }
}
export function timingHeader(t: ApiTiming) {
  return `sql;dur=${t.sqlMs.toFixed(3)}, sql-count;desc="${t.sqlCount}", aggregate;dur=${t.aggregateMs.toFixed(3)}, json;dur=${t.jsonMs.toFixed(3)}, compression;dur=${t.compressionMs.toFixed(3)}`;
}
