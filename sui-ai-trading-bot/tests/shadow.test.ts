import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import { calculate } from "../packages/indicators/src/index.ts";
import { dayKey, type Candle } from "../packages/shared/src/index.ts";
import {
  ShadowRecorder,
  bigMove60mPct,
  freezeSnapshot,
  shadowRegime,
  SHADOW_PROMPT_VERSION,
  type ShadowInput,
} from "../apps/worker/src/shadow.ts";
const dbs: BotDatabase[] = [];
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
async function fixture(db = new BotDatabase(":memory:")) {
  dbs.push(db);
  const now = Date.UTC(2026, 10, 13, 3);
  const candles: Candle[] = Array.from({ length: 340 }, (_, i) => ({
    timestamp: Math.floor(now / 1000) - (340 - i) * 300,
    open: 2,
    high: 2.1,
    low: 1.9,
    close: 2,
    volume: 10,
    timeframe: 300,
    source: "fixture",
  }));
  const decision = await new RuleBasedStrategy(db.settings()).analyze({
    candles,
    current: calculate(candles),
    previous: calculate(candles.slice(0, -1)),
    entryPrice: null,
    now,
  });
  decision.evidence!.conditions = {
    emaUp: false,
    rsiRecovery: false,
    histogramImproving: false,
  };
  const input: ShadowInput = {
    cycleId: "cycle-0",
    pair: "SUI_USDC",
    now,
    candles,
    decision,
    portfolio: db.portfolio(),
    settings: db.settings(),
    healthy: true,
    market: {
      configured: "deepbook",
      source: "DeepBook",
      fallback: false,
      healthy: true,
      lastSuccessAt: now,
      latencyMs: 1,
      reason: null,
      bookAt: now,
      bid: 1.99,
      ask: 2.01,
      spread: 0.02,
    },
  };
  return { db, input };
}
function output() {
  return {
    action: "BUY",
    confidence: 0.8,
    rationale: {
      refs: [{ type: "book", key: "bid", value: 1.99 }],
      text: "fixture rationale",
    },
    model: "fake-only",
    promptVersion: SHADOW_PROMPT_VERSION,
    usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
  };
}
function advance(i: ShadowInput, ms = 300000) {
  i.now += ms;
  i.cycleId = `cycle-${i.now}`;
}
function rows(db: BotDatabase) {
  return db.history<{
    status: string;
    reasonCode?: string;
    action?: string;
    snapshot: ReturnType<typeof freezeSnapshot>["snapshot"];
    snapshotSha256: string;
    triggerType?: string;
  }>("shadow_decisions", 1000);
}
function setBigMove(i: ShadowInput, percent: number) {
  const window = i.candles.slice(-13);
  for (const candle of window) candle.close = 2;
  window.at(-1)!.close = 2 * (1 + percent / 100);
}
it("OFF and missing adapter never evaluate input or freeze/append/reserve", () => {
  const read = vi.fn(() => {
    throw Error("must not read");
  });
  new ShadowRecorder(
    { append: vi.fn(), reserveShadowCall: vi.fn(), shadowLastCall: vi.fn() },
    { complete: vi.fn() },
    () => false,
  ).offer(read);
  new ShadowRecorder(
    { append: vi.fn(), reserveShadowCall: vi.fn(), shadowLastCall: vi.fn() },
    undefined,
    () => true,
  ).offer(read);
  expect(read).not.toHaveBeenCalled();
});
it("freezes all same-cycle fields, sha256 and nested values before queued invocation", async () => {
  const { db, input } = await fixture();
  const frozen = freezeSnapshot(input, { type: "initial" });
  const complete = vi.fn(async (request) => {
    expect(request.snapshot).toEqual(frozen.snapshot);
    expect(JSON.parse(request.prompt).snapshot).toEqual(frozen.snapshot);
    expect(Object.isFrozen(request.snapshot.evidence.inputs)).toBe(true);
    return output();
  });
  const recorder = new ShadowRecorder(db, { complete }, () => true);
  recorder.offer(() => input);
  expect(complete).not.toHaveBeenCalled();
  input.candles.at(-1)!.close = 99;
  input.settings.maxOrder = 1;
  input.market!.bid = 88;
  await turn();
  await turn();
  const row = rows(db)[0];
  expect(row.status).toBe("OK");
  expect(row.snapshot.candles).toHaveLength(50);
  expect(row.snapshotSha256).toBe(
    createHash("sha256").update(JSON.stringify(row.snapshot)).digest("hex"),
  );
  expect(row.snapshotSha256).toBe(frozen.snapshotSha256);
  expect(row.snapshot.book).toEqual({
    bid: 1.99,
    ask: 2.01,
    spread: 0.02,
    fetchedAt: input.now,
  });
  expect(row.triggerType).toBe("initial");
  expect(row.snapshot.triggerType).toBe("initial");
});
it("big-move is edge-triggered across a 60-minute window with hysteresis", async () => {
  const { db, input } = await fixture();
  const snapshots: ReturnType<typeof freezeSnapshot>["snapshot"][] = [];
  const complete = vi.fn(async ({ snapshot }) => {
    snapshots.push(snapshot);
    return output();
  });
  const r = new ShadowRecorder(db, { complete }, () => true);
  r.offer(() => input);
  await turn();
  await turn();

  advance(input);
  setBigMove(input, 1);
  expect(bigMove60mPct(input.candles)).toBeCloseTo(1);
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(2);
  expect(snapshots.at(-1)).toMatchObject({
    triggerType: "big-move",
    bigMove60mPct: expect.closeTo(1),
  });

  advance(input);
  setBigMove(input, 1.4);
  r.offer(() => input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(2);

  advance(input);
  setBigMove(input, 0.79);
  r.offer(() => input);
  await turn();
  advance(input);
  setBigMove(input, -1.1);
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(3);
  expect(snapshots.at(-1)).toMatchObject({
    triggerType: "big-move",
    bigMove60mPct: expect.closeTo(-1.1),
  });
});
it("big-move ignores sub-threshold and incomplete windows", async () => {
  const { db, input } = await fixture();
  const complete = vi.fn(async () => output());
  const lastCall = input.now;
  const budget = {
    reserveShadowCall: vi.fn(() => true),
    shadowLastCall: vi.fn(() => lastCall),
  };
  const r = new ShadowRecorder(db, { complete }, () => true, budget);
  input.candles = input.candles.slice(-12);
  r.offer(() => input);
  advance(input);
  setBigMove(input, 0.99);
  r.offer(() => input);
  await turn();
  expect(complete).not.toHaveBeenCalled();
  expect(bigMove60mPct(input.candles)).toBeUndefined();

  input.candles.unshift({
    ...input.candles[0],
    timestamp: input.candles[0].timestamp - 300,
  });
  r.offer(() => input);
  advance(input);
  setBigMove(input, 1);
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(1);
});
it("big-move obeys position, minimum-interval and daily-budget gates", async () => {
  const holding = await fixture();
  const holdingComplete = vi.fn(async () => output());
  const holdingRecorder = new ShadowRecorder(
    holding.db,
    { complete: holdingComplete },
    () => true,
  );
  setBigMove(holding.input, 0);
  holdingRecorder.offer(() => holding.input);
  holding.input.portfolio.sui = 1;
  advance(holding.input);
  setBigMove(holding.input, 1.1);
  holdingRecorder.offer(() => holding.input);
  await turn();
  expect(holdingComplete).toHaveBeenCalledTimes(1);

  const limited = await fixture();
  const limitedComplete = vi.fn(async () => output());
  const limitedRecorder = new ShadowRecorder(
    limited.db,
    { complete: limitedComplete },
    () => true,
  );
  limitedRecorder.offer(() => limited.input);
  await turn();
  await turn();
  advance(limited.input, 299999);
  setBigMove(limited.input, 1.1);
  limitedRecorder.offer(() => limited.input);
  await turn();
  expect(limitedComplete).toHaveBeenCalledTimes(1);

  const capped = await fixture();
  const cappedComplete = vi.fn(async () => output());
  const budget = {
    reserveShadowCall: vi.fn(() => false),
    shadowLastCall: vi.fn(() => capped.input.now - 300000),
  };
  const cappedRecorder = new ShadowRecorder(
    capped.db,
    { complete: cappedComplete },
    () => true,
    budget,
  );
  setBigMove(capped.input, 0);
  cappedRecorder.offer(() => capped.input);
  advance(capped.input);
  setBigMove(capped.input, 1.1);
  cappedRecorder.offer(() => capped.input);
  await turn();
  await turn();
  expect(cappedComplete).not.toHaveBeenCalled();
  expect(rows(capped.db)[0]).toMatchObject({
    status: "SKIPPED_BUDGET",
    triggerType: "big-move",
  });
});
it("heartbeat, minimum interval, increasing conditions, near BUY and BUY signals", async () => {
  const { db, input } = await fixture();
  const complete = vi.fn(async () => output());
  const r = new ShadowRecorder(db, { complete }, () => true);
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(1);
  advance(input, 299999);
  input.decision.action = "BUY";
  r.offer(() => input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(1);
  advance(input, 1);
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(2);
  advance(input);
  input.decision.action = "WAIT";
  input.decision.evidence!.conditions.emaUp = true;
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(3);
  advance(input);
  input.decision.evidence!.conditions.rsiRecovery = true;
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(4);
  advance(input);
  input.decision.evidence!.conditions = {};
  r.offer(() => input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(4);
  advance(input, 600000);
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(5);
});
it.each(["holding", "unhealthy", "missing-evidence"])(
  "suppresses %s without rows",
  async (mode) => {
    const { db, input } = await fixture();
    if (mode === "holding") input.portfolio.sui = 1;
    if (mode === "unhealthy") input.healthy = false;
    if (mode === "missing-evidence") delete input.decision.evidence;
    const complete = vi.fn(async () => output());
    new ShadowRecorder(db, { complete }, () => true).offer(() => input);
    await turn();
    expect(complete).not.toHaveBeenCalled();
    expect(rows(db)).toEqual([]);
  },
);
it.each([
  ["INVALID_JSON", (): unknown => "broken"],
  ["INVALID_SCHEMA", () => ({ ...output(), action: "SELL" })],
  ["INVALID_SCHEMA", () => ({ ...output(), confidence: NaN })],
  ["INVALID_SCHEMA", () => ({ ...output(), promptVersion: "unknown" })],
  [
    "INVALID_SCHEMA",
    () => ({ ...output(), rationale: { refs: [], text: "a".repeat(201) } }),
  ],
  [
    "INVALID_REFERENCE",
    () => ({
      ...output(),
      rationale: {
        refs: [{ type: "book", key: "bid", value: 99 }],
        text: "bad",
      },
    }),
  ],
  [
    "INVALID_REFERENCE",
    () => ({
      ...output(),
      rationale: {
        refs: [{ type: "book", key: "unknown", value: 1 }],
        text: "bad",
      },
    }),
  ],
  [
    "ADAPTER_FAILED",
    () => {
      throw Error("secret provider payload");
    },
  ],
] as const)(
  "records %s without retaining broken output",
  async (code, result) => {
    const { db, input } = await fixture();
    new ShadowRecorder(
      db,
      { complete: async () => result() },
      () => true,
    ).offer(() => input);
    await turn();
    await turn();
    const row = rows(db)[0];
    expect(row.status).toBe("ERROR");
    expect(row.reasonCode).toBe(code);
    expect(row.action).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("secret provider payload");
  },
);
it("rejects credential echo and never stores the key or exception message", async () => {
  vi.stubEnv("SUIBA_SHADOW_API_KEY", "fixture-key-123");
  const { db, input } = await fixture();
  new ShadowRecorder(
    db,
    { complete: async () => ({ ...output(), model: "fixture-key-123" }) },
    () => true,
  ).offer(() => input);
  await turn();
  await turn();
  expect(rows(db)[0].reasonCode).toBe("CREDENTIAL_IN_OUTPUT");
  expect(JSON.stringify(rows(db))).not.toContain("fixture-key-123");
});
it("timeout is 30s, aborts and records ERROR; ignores late result and keeps physical single flight", async () => {
  const { db, input } = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let finish!: (value: unknown) => void;
  let signal!: AbortSignal;
  const complete = vi.fn((request) => {
    signal = request.signal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const r = new ShadowRecorder(db, { complete }, () => true);
  r.offer(() => input);
  await turn();
  r.offer(() => input);
  expect(complete).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29999);
  expect(rows(db)).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  expect(rows(db)[0].reasonCode).toBe("TIMEOUT");
  advance(input, 900000);
  r.offer(() => input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(1);
  finish(output());
  await turn();
  expect(rows(db)).toHaveLength(1);
  r.offer(() => input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(2);
  finish(output());
  await turn();
});
it("persists 200-call JST budget across restart, including reserved calls lost to crash, rolls next day", async () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-shadow-"));
  dirs.push(dir);
  const path = join(dir, "bot.sqlite");
  let db = new BotDatabase(path);
  const day = "2026-11-13";
  const start = Date.UTC(2026, 10, 12, 15);
  for (let n = 0; n < 200; n++)
    expect(db.reserveShadowCall(day, start + n * 300000)).toBe(true);
  db.close();
  db = new BotDatabase(path);
  dbs.push(db);
  expect(db.reserveShadowCall(day, start + 200 * 300000)).toBe(false);
  const { input } = await fixture();
  input.now = start + 201 * 300000;
  input.decision.action = "BUY";
  expect(dayKey(input.now)).toBe(day);
  const complete = vi.fn(async () => output());
  const r = new ShadowRecorder(db, { complete }, () => true);
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).not.toHaveBeenCalled();
  expect(rows(db)[0].status).toBe("SKIPPED_BUDGET");
  advance(input, 86400000);
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(1);
});
it("storage and adapter failures cannot escape offer or mutate strategy/portfolio/settings/runtime", async () => {
  const { db, input } = await fixture();
  db.recordAnalysis(
    input.cycleId,
    input.decision,
    calculate(input.candles),
    input.now,
  );
  const before = [
    db.portfolio(),
    db.settings(),
    db.runtime(),
    db.history("strategy_decisions"),
  ];
  const append = vi.spyOn(db, "append").mockImplementation(() => {
    throw Error("disk failure");
  });
  const r = new ShadowRecorder(
    db,
    {
      complete: async () => {
        throw Error("secret");
      },
    },
    () => true,
  );
  expect(() => r.offer(() => input)).not.toThrow();
  await turn();
  await turn();
  expect(append).toHaveBeenCalledWith(
    "shadow_decisions",
    input.cycleId,
    expect.objectContaining({ status: "ERROR" }),
    input.now,
  );
  expect([
    db.portfolio(),
    db.settings(),
    db.runtime(),
    db.history("strategy_decisions"),
  ]).toEqual(before);
  expect(() =>
    r.offer(() => {
      throw Error("input source");
    }),
  ).not.toThrow();
});
it("regime bands match review EMA50 and cross only with sufficient 24h input", async () => {
  const { input } = await fixture();
  expect(shadowRegime(input.candles)).toBe("range");
  expect(shadowRegime(input.candles.slice(-50))).toBe("unknown");
  for (const c of input.candles.slice(-100)) c.close = 3;
  expect(shadowRegime(input.candles)).toBe("up");
  for (const c of input.candles.slice(-100)) c.close = 1;
  expect(shadowRegime(input.candles)).toBe("down");
});

it.each(
  ["off", "error", "pending"].flatMap((mode) =>
    ["UPSTREAM_HTTP_429", "UPSTREAM_HTTP_500"].map((code) => ({ mode, code })),
  ),
)(
  "real tick completes with shadow $mode and preserves stop $code",
  async ({ mode, code }) => {
    const { BotEngine } = await import("../apps/worker/src/engine.ts");
    const { apiAccess } = await import("../packages/shared/src/api.ts");
    const { db, input } = await fixture();
    vi.stubEnv("SUIBA_SHADOW_ENABLED", mode === "off" ? "false" : "true");
    let release!: (v: unknown) => void;
    const complete = vi.fn(async () => {
      if (mode === "error") throw Error("private error");
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const frames = () =>
      Object.fromEntries(
        ([300, 900, 3600] as const).map((tf) => {
          const end = Math.floor(Date.now() / (tf * 1000)) * tf - tf;
          return [
            tf,
            Array.from({ length: 70 }, (_, n) => ({
              ...input.candles[0],
              source: "fixture",
              timeframe: tf,
              timestamp: end - (69 - n) * tf,
            })),
          ];
        }),
      );
    const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
    const router = { getQuote: vi.fn(), validateQuote: vi.fn() };
    const engine = new BotEngine(
      db,
      {
        candles: async (tf) => frames()[tf],
        frames: async () => frames(),
        status: () => ({ ...input.market!, bookAt: Date.now() }),
      },
      router,
      { status: health, health: async () => health },
      "SUI_USDC",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { complete },
    );
    const before = db.portfolio();
    try {
      await engine.tick();
      expect(db.history("strategy_decisions")).toHaveLength(1);
      expect(complete).not.toHaveBeenCalled(); // invocation is outside tick promise
      await turn();
      await turn();
      expect(complete).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
      expect(db.runtime().error).toBeNull();
      await engine.tick(); // never waits for a pending adapter
      expect(db.history("strategy_decisions")).toHaveLength(2);
      expect(db.history("paper_orders")).toEqual([]);
      expect(router.getQuote).not.toHaveBeenCalled();
      expect(db.portfolio().sui).toBe(before.sui);
      expect(db.settings()).toEqual(input.settings);
      const ids = db
        .history<{ analysisContext: { cycleId: string } }>("strategy_decisions")
        .map((d) => d.analysisContext.cycleId);
      const recorded = db.history<{ cycleId: string; status: string }>(
        "shadow_decisions",
      );
      if (mode === "error") {
        expect(recorded[0].status).toBe("ERROR");
        expect(ids).toContain(recorded[0].cycleId);
      }
      if (mode === "off") expect(recorded).toEqual([]);
      engine.monitor.stop(code);
      expect(db.runtime()).toMatchObject({ running: false, error: code });
      if (mode === "pending") {
        release(output());
        await turn();
      }
    } finally {
      apiAccess.onTransientFailure = () => {};
      apiAccess.onRateLimit = () => {};
    }
  },
);

it("pair recorders share single flight, minimum cadence and durable budget store", async () => {
  const a = await fixture(),
    b = await fixture(),
    budget = new BotDatabase(":memory:");
  dbs.push(budget);
  b.input.pair = "WAL_USDC";
  let release!: (v: unknown) => void;
  const complete = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const ra = new ShadowRecorder(a.db, { complete }, () => true, budget);
  const rb = new ShadowRecorder(b.db, { complete }, () => true, budget);
  ra.offer(() => a.input);
  rb.offer(() => b.input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(1);
  release(output());
  await turn();
  rb.offer(() => b.input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(1);
  advance(b.input, 900000);
  rb.offer(() => b.input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(2);
  release(output());
  await turn();
  expect(rows(a.db)).toHaveLength(1);
  expect(rows(b.db)).toHaveLength(1);
  expect(a.db.shadowLastCall()).toBeNull();
  expect(budget.shadowLastCall()).toBe(b.input.now);
});
it("regime change triggers before heartbeat and no cross-day minimum-interval reset", async () => {
  const { db, input } = await fixture();
  const complete = vi.fn(async () => output());
  const r = new ShadowRecorder(db, { complete }, () => true);
  r.offer(() => input);
  await turn();
  await turn();
  advance(input);
  input.candles.slice(-100).forEach((c) => {
    c.close = 3;
  });
  r.offer(() => input);
  await turn();
  await turn();
  expect(complete).toHaveBeenCalledTimes(2);
  const later = Date.UTC(2026, 10, 13, 14, 59);
  expect(db.reserveShadowCall(dayKey(later), later)).toBe(true);
  input.now = later + 120000;
  input.decision.action = "BUY";
  r.offer(() => input);
  await turn();
  expect(complete).toHaveBeenCalledTimes(2);
});
it("switching OFF before queued invocation does not consume budget or append", async () => {
  const { db, input } = await fixture();
  let enabled = true;
  const complete = vi.fn(async () => output());
  new ShadowRecorder(db, { complete }, () => enabled).offer(() => input);
  enabled = false;
  await turn();
  expect(complete).not.toHaveBeenCalled();
  expect(rows(db)).toEqual([]);
  expect(db.shadowLastCall()).toBeNull();
});

it.each(
  ["off", "error", "pending"].flatMap((mode) =>
    ["network-time", "network-count", "book-time", "book-count"].map(
      (limit) => ({ mode, limit }),
    ),
  ),
)(
  "preserves $limit recovery limit with shadow $mode",
  async ({ mode, limit }) => {
    const { OperationMonitor } =
      await import("../apps/worker/src/operations.ts");
    const { db, input } = await fixture();
    db.set("runtime", { ...db.runtime(), running: true });
    const monitor = new OperationMonitor(db);
    monitor.beginCycle();
    let release!: (v: unknown) => void;
    new ShadowRecorder(
      db,
      {
        complete: async () => {
          if (mode === "error") throw Error("shadow fault");
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
      () => mode !== "off",
    ).offer(() => input);
    await turn();
    await turn();
    const start = input.now;
    const fail = (at: number) => {
      if (limit.startsWith("book"))
        monitor.bookGuardThrowToEpisode("SPREAD_TOO_WIDE", at);
      else
        monitor.transientFailure(
          "DeepBook Indexer",
          "UPSTREAM_BODY_TIMEOUT",
          {
            api: "DeepBook Indexer",
            host: "deepbook-indexer.mainnet.mystenlabs.com",
            url: "https://fixture.invalid/",
            operation: "OHLCV_FETCH",
            method: "GET",
            code: "UPSTREAM_BODY_TIMEOUT",
            phase: "BODY",
            timeoutType: "BODY",
            causeCode: null,
            status: null,
            elapsedMs: 8000,
            occurredAt: at,
          },
          at,
        );
    };
    fail(start);
    if (limit.endsWith("time")) {
      const duration = limit.startsWith("book") ? 1800000 : 180000;
      monitor.checkRecoveryDeadline(start + duration - 1);
      expect(db.runtime().error).toBeNull();
      monitor.checkRecoveryDeadline(start + duration);
    } else {
      const count = limit.startsWith("book") ? 61 : 9;
      const step = limit.startsWith("book") ? 30000 : 1000;
      for (let n = 1; n < count - 1; n++) fail(start + n * step);
      expect(db.runtime().error).toBeNull();
      fail(start + (count - 1) * step);
      expect(monitor.safety().failures).toBe(count);
    }
    expect(db.runtime()).toMatchObject({
      running: false,
      error: "PAPER_RECOVERY_EXHAUSTED",
    });
    if (mode === "pending") {
      release(output());
      await turn();
    }
  },
);
