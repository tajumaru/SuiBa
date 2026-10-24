import { createHistogram, monitorEventLoopDelay } from "node:perf_hooks";
/** Optional, local metrics only. No transport, query, retry, sampling RPC or DB writes. */
export function installPreflightMetrics(prototype, emit) {
  if (
    typeof emit !== "function" ||
    ["append", "set", "transaction"].some(
      (name) => typeof prototype[name] !== "function",
    )
  )
    throw Error("INVALID_METRICS_TARGET");
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const originals = new Map(),
    wrapped = new Map(),
    histograms = new Map();
  const seenErrors = new WeakSet();
  let busy = 0,
    locked = 0,
    stopped = false;
  for (const name of ["append", "set", "transaction"]) {
    const original = prototype[name];
    if (typeof original !== "function") throw Error("INVALID_METRICS_TARGET");
    originals.set(name, original);
    const histogram = createHistogram();
    histograms.set(name, { histogram, failures: 0 });
    const wrapper = function (...args) {
      const start = performance.now();
      try {
        return Reflect.apply(original, this, args);
      } catch (error) {
        histograms.get(name).failures++;
        if (error && typeof error === "object" && !seenErrors.has(error)) {
          seenErrors.add(error);
          const primary =
            typeof error.errcode === "number" ? error.errcode & 255 : null;
          if (primary === 5) busy++;
          if (primary === 6) locked++;
        }
        throw error;
      } finally {
        histogram.record(
          Math.max(1, Math.round((performance.now() - start) * 1000)),
        );
      }
    };
    wrapped.set(name, wrapper);
    prototype[name] = wrapper;
  }
  const stats = (h, scale) => ({
    count: h.count,
    p50Ms: h.count ? h.percentile(50) / scale : null,
    p95Ms: h.count ? h.percentile(95) / scale : null,
    maxMs: h.count ? h.max / scale : null,
  });
  function sample() {
    if (stopped) throw Error("METRICS_CLOSED");
    emit({
      event: "PREFLIGHT_PASSIVE_METRICS",
      scope: "CUMULATIVE",
      at: Date.now(),
      eventLoop: stats(delay, 1e6),
      sqlite: Object.fromEntries(
        [...histograms].map(([name, { histogram, failures }]) => [
          name,
          { ...stats(histogram, 1000), failures },
        ]),
      ),
      sqliteBusy: busy,
      sqliteLocked: locked,
    });
  }
  const timer = setInterval(sample, 15000);
  timer.unref();
  return {
    sample,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      delay.disable();
      for (const [name, original] of originals)
        if (prototype[name] === wrapped.get(name)) prototype[name] = original;
    },
  };
}
