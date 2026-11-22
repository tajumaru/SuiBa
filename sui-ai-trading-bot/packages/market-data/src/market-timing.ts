import { AsyncLocalStorage } from "node:async_hooks";

export type MarketTimings = Record<
  string,
  { count: number; totalMs: number; maxMs: number }
>;

const scope = new AsyncLocalStorage<MarketTimings>();

export function withMarketTiming<T>(timings: MarketTimings, fn: () => T): T {
  return scope.run(timings, fn);
}

export function startMarketStage(stage: string) {
  const timings = scope.getStore();
  if (!timings) return;
  const start = performance.now();
  return () => {
    const elapsed = performance.now() - start;
    const stats = (timings[stage] ??= { count: 0, totalMs: 0, maxMs: 0 });
    stats.count++;
    stats.totalMs += elapsed;
    stats.maxMs = Math.max(stats.maxMs, elapsed);
  };
}

export function timeMarketStage<T>(stage: string, fn: () => Promise<T>) {
  const finish = startMarketStage(stage);
  const result = fn();
  return finish ? result.finally(finish) : result;
}
