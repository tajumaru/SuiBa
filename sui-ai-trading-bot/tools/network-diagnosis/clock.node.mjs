import test from "node:test";
import assert from "node:assert/strict";
import { measurementWindow, waitUntil, durationEvidence } from "./clock.mjs";
import { LIMITS } from "./core.mjs";

function fakeClock(change = () => {}) {
  const state = { wallMs: 1000, monotonicMs: 0, sleeps: 0 };
  return {
    state,
    read: () => ({ wallMs: state.wallMs, monotonicMs: state.monotonicMs }),
    async sleep(ms, signal) {
      signal.throwIfAborted();
      state.sleeps++;
      state.wallMs += ms;
      state.monotonicMs += ms;
      change(state, ms);
    },
  };
}
const signal = () => new AbortController().signal;

test("early timer wakes are rechecked at start and end, without a tolerance or real waiting", async () => {
  const clock = fakeClock((s) => {
    if (s.sleeps <= 2) {
      s.wallMs -= 205;
      s.monotonicMs -= 205;
    }
  });
  const window = measurementWindow(2000, clock);
  const start = await window.start(signal());
  assert.ok(start.wallMs >= 2000);
  await window.waitEnd(signal());
  const end = window.snapshot();
  assert.ok(end.wallElapsedMs >= LIMITS.durationMs);
  assert.ok(end.monotonicElapsedMs >= LIMITS.durationMs);
  const early = fakeClock((s) => {
    if (s.sleeps === 1) {
      s.wallMs -= 205;
      s.monotonicMs -= 205;
    }
  });
  const w = measurementWindow(1000, early);
  await w.start(signal());
  await w.waitEnd(signal());
  assert.ok(w.snapshot().monotonicElapsedMs >= LIMITS.durationMs);
});
test("backwards wall clock waits longer and preserves the measured drift", async () => {
  const clock = fakeClock((s) => {
    if (s.sleeps === 1) s.wallMs -= 205;
  });
  const window = measurementWindow(1000, clock);
  await window.start(signal());
  await window.waitEnd(signal());
  const end = window.snapshot();
  assert.equal(end.wallDriftMs, -205);
  assert.ok(end.wallElapsedMs >= LIMITS.durationMs);
  assert.ok(end.monotonicElapsedMs >= LIMITS.durationMs + 205);
});
test("forward wall-clock jumps cannot shorten the monotonic 30-minute window", async () => {
  const clock = fakeClock((s) => {
    if (s.sleeps === 1) s.wallMs += 60000;
  });
  const window = measurementWindow(1000, clock);
  await window.start(signal());
  await window.waitEnd(signal());
  assert.equal(window.snapshot().monotonicElapsedMs, LIMITS.durationMs);
  assert.equal(window.snapshot().wallDriftMs, 60000);
});
test("monotonic-only slot waits recheck early wakes and cancellation remains effective", async () => {
  const clock = fakeClock((s) => {
    if (s.sleeps === 1) {
      s.wallMs -= 0.5;
      s.monotonicMs -= 0.5;
    }
  });
  assert.ok((await waitUntil(null, 100, signal(), clock)).monotonicMs >= 100);
  const control = new AbortController();
  control.abort(Error("USER_STOP"));
  await assert.rejects(
    waitUntil(99999, null, control.signal, clock),
    /USER_STOP/,
  );
  const window = measurementWindow(1000, clock);
  await window.start(signal());
  await assert.rejects(window.waitEnd(control.signal), /USER_STOP/);
});

function fixture(wall = LIMITS.durationMs, mono = LIMITS.durationMs) {
  const start = {
    kind: "measurement-start",
    at: 1000,
    clock: { wallMs: 1000, monotonicMs: 10 },
  };
  const end = {
    at: 1000 + wall,
    reason: "RUN_DEADLINE",
    clock: {
      start: { ...start.clock },
      end: { wallMs: 1000 + wall, monotonicMs: 10 + mono },
      wallElapsedMs: wall,
      monotonicElapsedMs: mono,
      wallDriftMs: wall - mono,
    },
  };
  return {
    start,
    end,
    environment: { startAt: 1000, endAt: 1000 + LIMITS.durationMs },
  };
}
test("duration evidence fails closed for short, missing, reversed, mismatched and cleanup-padded clocks", () => {
  const check = (f) => durationEvidence(f.start, f.end, f.environment);
  assert.equal(check(fixture()).complete, true);
  for (const f of [
    fixture(LIMITS.durationMs - 205),
    fixture(LIMITS.durationMs, LIMITS.durationMs - 1),
    fixture(-1, -1),
  ])
    assert.equal(check(f).complete, false);
  const padded = fixture(LIMITS.durationMs - 205);
  padded.end.at += 5000;
  assert.equal(check(padded).complete, false);
  const missing = fixture();
  delete missing.end.clock;
  assert.equal(check(missing).reason, "MISSING_CLOCK_EVIDENCE");
  const changed = fixture();
  changed.end.clock.start.monotonicMs++;
  assert.equal(check(changed).reason, "CLOCK_EVIDENCE_MISMATCH");
  const bad = fixture();
  bad.end.clock.monotonicElapsedMs = NaN;
  assert.equal(check(bad).complete, false);
  const stopped = fixture();
  stopped.end.reason = "CYCLES_FAILED_3_CONSECUTIVE";
  assert.equal(check(stopped).complete, false);
  const late = fixture();
  late.environment.startAt++;
  late.environment.endAt++;
  assert.equal(check(late).complete, false);
});
