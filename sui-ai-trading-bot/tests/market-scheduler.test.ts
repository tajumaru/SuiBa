import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MarketCadence,
  MarketScheduler,
  cadenceLimits,
  type CadenceInput,
} from "../apps/worker/src/scheduler.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { ApiAccess } from "../packages/shared/src/api.ts";
import type { Candle, Timeframe } from "../packages/shared/src/index.ts";
const boundary = Date.UTC(2026, 9, 21, 12, 40);
const clock = { wall: () => Date.now(), mono: () => performance.now() };
const input: CadenceInput = {
  intervalMs: 60000,
  deepbook: true,
  latestClosedAt: null,
  healthy: true,
  blocked: false,
};
beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "Date",
      "performance",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
  vi.setSystemTime(boundary - 1000);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const db = new BotDatabase(":memory:"),
    monitor = new OperationMonitor(db, Date.now(), clock.mono);
  monitor.boot();
  db.set("runtime", { ...db.runtime(), running: true });
  monitor.transition("MANUAL_START");
  return { db, monitor };
}
it("does not accumulate 7 seconds of execution time into each 60-second period", async () => {
  vi.setSystemTime(boundary + 10000);
  const starts: number[] = [];
  const s = new MarketScheduler(
    async () => {
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 7000));
    },
    () => input,
    () => {},
    (e) => {
      throw e;
    },
    clock,
  );
  s.start();
  await vi.advanceTimersByTimeAsync(250000);
  s.stop();
  expect(starts.length).toBeGreaterThan(3);
  for (let i = 2; i < starts.length; i++)
    expect(starts[i] - starts[i - 1]).toBe(60000);
  expect(starts.slice(1).every((t) => t % 60000 === 10000)).toBe(true);
});
it("keeps minimum 30s spacing even when boot occurs immediately before the phase", async () => {
  vi.setSystemTime(boundary + 9000);
  const starts: number[] = [];
  const s = new MarketScheduler(
    async () => {
      starts.push(Date.now());
    },
    () => input,
    () => {},
    (e) => {
      throw e;
    },
    clock,
  );
  s.start();
  await vi.advanceTimersByTimeAsync(150000);
  s.stop();
  expect(starts.slice(1).every((t, i) => t - starts[i] >= 30000)).toBe(true);
});
it("does not overlap or replay missed cycles when work takes 125 seconds", async () => {
  let active = 0,
    max = 0;
  const starts: number[] = [];
  const s = new MarketScheduler(
    async () => {
      active++;
      max = Math.max(max, active);
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 125000));
      active--;
    },
    () => input,
    () => {},
    (e) => {
      throw e;
    },
    clock,
  );
  s.start();
  s.start();
  await vi.advanceTimersByTimeAsync(310000);
  s.stop();
  expect(max).toBe(1);
  expect(starts.length).toBeLessThanOrEqual(3);
  for (let i = 1; i < starts.length; i++)
    expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(125000);
});
it("uses monotonic deadlines despite a wall-clock jump", async () => {
  const starts: number[] = [];
  const s = new MarketScheduler(
    async () => {
      starts.push(performance.now());
    },
    () => ({ ...input, deepbook: false }),
    () => {},
    (e) => {
      throw e;
    },
    clock,
  );
  s.start();
  await vi.advanceTimersByTimeAsync(10000);
  vi.setSystemTime(Date.now() + 3600000);
  await vi.advanceTimersByTimeAsync(50000);
  expect(starts).toEqual([0, 60000]);
  s.stop();
});
it("gives a bounded boundary recheck at +40s, never a polling loop", () => {
  vi.setSystemTime(boundary + 10000);
  const cadence = new MarketCadence(clock);
  const started = performance.now();
  const i = { ...input, latestClosedAt: boundary - 300000 };
  let p = cadence.next(started, i);
  expect(p.reason).toBe("BOUNDARY_RECHECK");
  expect(p.at).toBe(boundary + 40000);
  vi.setSystemTime(boundary + 40000);
  p = cadence.next(performance.now(), i);
  expect(p.reason).not.toBe("BOUNDARY_RECHECK");
});
it.each([{ healthy: false }, { blocked: true }, { deepbook: false }])(
  "does not add rechecks after error/backoff or on Gecko: %j",
  (extra) => {
    vi.setSystemTime(boundary + 10000);
    const c = new MarketCadence(clock);
    expect(
      c.next(performance.now(), {
        ...input,
        latestClosedAt: boundary - 300000,
        ...extra,
      }).reason,
    ).not.toBe("BOUNDARY_RECHECK");
  },
);
it("retains the 67s fetch/361s candle stop, even during acquisition", async () => {
  vi.setSystemTime(boundary + 61000);
  const { db, monitor } = fixture();
  monitor.market(boundary - 300000, Date.now() - 67000);
  monitor.transportSuccess();
  let release!: () => void;
  const pending = monitor.acquisition(
    () => new Promise<void>((r) => (release = r)),
  );
  monitor.watchdog();
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "MARKET_DATA_STALLED",
  });
  const stop = db
    .history<any>("operation_events")
    .find((x) => x.kind === "STOP" && x.code === "MARKET_DATA_STALLED");
  expect(stop.details).toMatchObject({
    candleAgeSeconds: 361,
    lastValidatedMarketAgeSeconds: 67,
    fetching: true,
    reasonDetail: "CANDLE_STALE",
  });
  expect(monitor.timing().transportRecent).toBe(true);
  expect(monitor.timing().dataStatus).toBe("STALE");
  release();
  await pending;
  db.close();
});
it("handles a normal 25s reflection delay without crossing the freshness deadline", async () => {
  vi.setSystemTime(boundary - 60000);
  const { db, monitor } = fixture();
  monitor.market(boundary - 300000);
  const starts: number[] = [];
  const scheduler = new MarketScheduler(
    async () => {
      const began = Date.now();
      starts.push(began);
      await monitor.acquisition(async () => {
        await new Promise((r) => setTimeout(r, 7000));
      });
      monitor.market(
        Date.now() >= boundary + 25000 ? boundary : boundary - 300000,
      );
      monitor.analysis();
    },
    () => ({ ...input, latestClosedAt: monitor.state().lastMarketClosedAt }),
    (p) => monitor.scheduled(p?.at ?? null, p?.reason ?? null),
    (e) => {
      throw e;
    },
    clock,
  );
  const watchdog = setInterval(() => monitor.watchdog(), 15000);
  scheduler.start();
  await vi.advanceTimersByTimeAsync(140000);
  scheduler.stop();
  clearInterval(watchdog);
  expect(starts).toContain(boundary + 10000);
  expect(starts).toContain(boundary + 40000);
  expect(db.runtime()).toMatchObject({ running: true, error: null });
  expect(monitor.state().lastMarketClosedAt).toBe(boundary);
  db.close();
});
it("does not exempt an in-flight request forever; deadline uses monotonic time", async () => {
  const { db, monitor } = fixture();
  monitor.market(Date.now());
  let release!: () => void;
  const pending = monitor.acquisition(
    () => new Promise<void>((r) => (release = r)),
  );
  void pending.catch(() => {});
  await vi.advanceTimersByTimeAsync(45001);
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "MARKET_DATA_STALLED",
  });
  const stop = db
    .history<any>("operation_events")
    .find((x) => x.code === "MARKET_DATA_STALLED" && x.kind === "STOP");
  expect(stop.details).toMatchObject({
    reasonDetail: "FETCH_DEADLINE_EXCEEDED",
    fetching: true,
  });
  release();
  await expect(pending).rejects.toThrow("MARKET_DATA_STALLED");
  db.close();
});
it("rejects concurrent acquisitions", async () => {
  const { db, monitor } = fixture();
  let release!: () => void;
  const pending = monitor.acquisition(
    () => new Promise<void>((r) => (release = r)),
  );
  await expect(monitor.acquisition(async () => 1)).rejects.toThrow(
    "MARKET_FETCH_IN_PROGRESS",
  );
  release();
  await pending;
  db.close();
});
it("really unchanged candles stop at 360s even though responses succeed", async () => {
  vi.setSystemTime(boundary + 59000);
  const { db, monitor } = fixture();
  monitor.market(boundary - 300000);
  await monitor.acquisition(async () => 42);
  expect(monitor.timing().dataStatus).toBe("UPDATING");
  await vi.advanceTimersByTimeAsync(2000);
  await monitor.acquisition(async () => 42);
  monitor.watchdog();
  expect(db.runtime().error).toBe("MARKET_DATA_STALLED");
  expect(monitor.timing().lastFetchSuccessAt).toBe(Date.now());
  expect(monitor.timing().dataStatus).toBe("STALE");
  db.close();
});
it("classifies boundary -1ms / +1ms separately from stale data", () => {
  vi.setSystemTime(boundary - 1);
  const { db, monitor } = fixture();
  monitor.market(boundary - 300000);
  expect(monitor.timing().dataStatus).toBe("FRESH");
  vi.setSystemTime(boundary + 1);
  expect(monitor.timing().dataStatus).toBe("UPDATING");
  vi.setSystemTime(boundary + 60001);
  monitor.watchdog();
  expect(db.runtime().running).toBe(false);
  db.close();
});
it.each([1, 3])(
  "stops on the first 8s timeout and bounded recovery never resumes PAPER (%i failures)",
  async (failures) => {
    const { db, monitor } = fixture(),
      a = new ApiAccess();
    a.onTransientFailure = (_api, code) => monitor.stop(code);
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 8000));
      if (calls <= failures) throw Error("UPSTREAM_TIMEOUT");
      return 42;
    };
    const p = monitor.acquisition(() =>
      a.run("DeepBook Indexer", "same", fn, 0, { maxTransientRetries: 2 }),
    );
    const outcome = p.then(
      () => "ok",
      (e) => e.message,
    );
    await vi.advanceTimersByTimeAsync(8000);
    expect(db.runtime()).toMatchObject({
      running: false,
      error: "UPSTREAM_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBeLessThanOrEqual(3);
    expect(await outcome).toBe(failures === 1 ? "ok" : "UPSTREAM_TIMEOUT");
    expect(db.runtime().running).toBe(false);
    db.close();
  },
);
it("boot clears old in-flight metadata and preserves sticky emergency/stop", () => {
  const { db, monitor } = fixture();
  db.set("runtime", {
    ...db.runtime(),
    running: false,
    emergency: true,
    error: "MARKET_DATA_STALLED",
  });
  db.set("operation_state", {
    ...monitor.state(),
    fetchStartedAt: Date.now(),
    nextFetchAt: Date.now() + 60000,
  });
  const reboot = new OperationMonitor(db, Date.now(), clock.mono);
  reboot.boot();
  expect(reboot.timing()).toMatchObject({
    fetchStartedAt: null,
    nextFetchAt: null,
  });
  expect(db.runtime()).toMatchObject({
    running: false,
    emergency: true,
    error: "MARKET_DATA_STALLED",
  });
  db.close();
});
it("emergency stop during fetch is immediate and subsequent completion cannot fill", async () => {
  vi.setSystemTime(boundary + 10000);
  const db = new BotDatabase(":memory:");
  let release!: (value: Candle[]) => void;
  const candles = (tf: Timeframe): Candle[] => {
    const last = Math.floor(Date.now() / (tf * 1000)) * tf - tf;
    return Array.from({ length: 70 }, (_, i) => ({
      timestamp: last - (69 - i) * tf,
      open: 2,
      high: 2.01,
      low: 1.99,
      close: 2,
      volume: 100,
      timeframe: tf,
      source: "DeepBook:SUI_USDC:USDC:verified-v1",
    }));
  };
  let first = true;
  const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const quote = vi.fn(async () => {
    throw Error("UNEXPECTED_ORDER");
  });
  const engine = new BotEngine(
    db,
    {
      candles: async (tf) =>
        first
          ? ((first = false), new Promise<Candle[]>((r) => (release = r)))
          : candles(tf),
    },
    { getQuote: quote, validateQuote: async () => false },
    { health: async () => health, status: health },
  );
  db.set("runtime", { ...db.runtime(), running: true });
  const pending = engine.tick();
  await vi.advanceTimersByTimeAsync(0);
  db.set("runtime", { ...db.runtime(), running: false, emergency: true });
  engine.monitor.transition("EMERGENCY_STOP");
  expect(db.runtime().emergency).toBe(true);
  release(candles(300));
  await pending;
  expect(db.runtime()).toMatchObject({ running: false, emergency: true });
  expect(quote).not.toHaveBeenCalled();
  expect(db.history("paper_trades")).toHaveLength(0);
  db.close();
});
it("scheduler stop leaves an outstanding acquisition alone and never starts another", async () => {
  let release!: () => void;
  const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
  const s = new MarketScheduler(
    tick,
    () => input,
    () => {},
    (e) => {
      throw e;
    },
    clock,
  );
  s.start();
  await vi.advanceTimersByTimeAsync(0);
  s.stop();
  release();
  await vi.advanceTimersByTimeAsync(3600000);
  expect(tick).toHaveBeenCalledTimes(1);
});

it("keeps PAPER running across twelve delayed publication boundaries with bounded traffic", async () => {
  vi.setSystemTime(boundary - 60000);
  const { db, monitor } = fixture();
  monitor.market(boundary - 300000);
  const starts: number[] = [];
  const scheduler = new MarketScheduler(
    async () => {
      starts.push(Date.now());
      await monitor.acquisition(async () => {
        await new Promise((r) => setTimeout(r, 7000));
      });
      const b = Math.floor(Date.now() / 300000) * 300000;
      monitor.market(Date.now() - b < 25000 ? b - 300000 : b);
      monitor.analysis();
    },
    () => ({ ...input, latestClosedAt: monitor.state().lastMarketClosedAt }),
    (p) => monitor.scheduled(p?.at ?? null, p?.reason ?? null),
    (e) => {
      throw e;
    },
    clock,
  );
  const timer = setInterval(() => monitor.watchdog(), 15000);
  scheduler.start();
  await vi.advanceTimersByTimeAsync(3600000);
  scheduler.stop();
  clearInterval(timer);
  expect(db.runtime()).toMatchObject({ running: true, error: null });
  expect(starts.length).toBeGreaterThanOrEqual(60);
  expect(starts.length).toBeLessThanOrEqual(75);
  expect(starts.slice(1).every((t, i) => t - starts[i] >= 30000)).toBe(true);
  db.close();
});
