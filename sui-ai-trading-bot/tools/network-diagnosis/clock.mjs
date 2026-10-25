import { pause, LIMITS } from "./core.mjs";

const systemClock = {
  read: () => ({ wallMs: Date.now(), monotonicMs: performance.now() }),
  sleep: pause,
};

// Timers may wake early and wall clocks may move independently of monotonic time.
// Recheck both clocks; never turn an early callback into completion evidence.
export async function waitUntil(
  wallAt,
  monotonicAt,
  signal,
  clock = systemClock,
) {
  while (true) {
    signal.throwIfAborted();
    const now = clock.read();
    const remaining = Math.max(
      wallAt == null ? 0 : wallAt - now.wallMs,
      monotonicAt == null ? 0 : monotonicAt - now.monotonicMs,
    );
    if (remaining <= 0) return now;
    await clock.sleep(
      Math.min(1000, Math.max(1, Math.ceil(remaining))),
      signal,
    );
  }
}

export function measurementWindow(plannedStartAt, clock = systemClock) {
  let start = null;
  return {
    async start(signal) {
      start = await waitUntil(plannedStartAt, null, signal, clock);
      return { ...start };
    },
    async waitEnd(signal) {
      if (!start) throw Error("MEASUREMENT_NOT_STARTED");
      return waitUntil(
        start.wallMs + LIMITS.durationMs,
        start.monotonicMs + LIMITS.durationMs,
        signal,
        clock,
      );
    },
    snapshot() {
      if (!start) return null;
      const end = clock.read();
      const monotonicElapsedMs = end.monotonicMs - start.monotonicMs;
      const wallElapsedMs = end.wallMs - start.wallMs;
      return {
        start: { ...start },
        end,
        monotonicElapsedMs,
        wallElapsedMs,
        wallDriftMs: wallElapsedMs - monotonicElapsedMs,
      };
    },
  };
}

export function durationEvidence(start, end, environment) {
  const c = end?.clock;
  const values = [
    start?.clock?.wallMs,
    start?.clock?.monotonicMs,
    c?.start?.wallMs,
    c?.start?.monotonicMs,
    c?.end?.wallMs,
    c?.end?.monotonicMs,
    c?.wallElapsedMs,
    c?.monotonicElapsedMs,
    c?.wallDriftMs,
    environment?.startAt,
    environment?.endAt,
    start?.at,
    end?.at,
  ];
  if (!values.every(Number.isFinite))
    return { complete: false, reason: "MISSING_CLOCK_EVIDENCE" };
  const consistent =
    start.clock.wallMs === c.start.wallMs &&
    start.clock.monotonicMs === c.start.monotonicMs &&
    start.at === c.start.wallMs &&
    c.wallElapsedMs === c.end.wallMs - c.start.wallMs &&
    c.monotonicElapsedMs === c.end.monotonicMs - c.start.monotonicMs &&
    c.wallDriftMs === c.wallElapsedMs - c.monotonicElapsedMs;
  if (!consistent)
    return { complete: false, reason: "CLOCK_EVIDENCE_MISMATCH" };
  if (
    environment.endAt !== environment.startAt + LIMITS.durationMs ||
    start.at < environment.startAt ||
    c.end.wallMs > end.at ||
    c.wallElapsedMs < LIMITS.durationMs ||
    c.monotonicElapsedMs < LIMITS.durationMs
  )
    return { ...c, complete: false, reason: "INSUFFICIENT_DURATION" };
  return { ...c, complete: end.reason === "RUN_DEADLINE", reason: end.reason };
}
