import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  apiAccess,
  apiFetch,
  RateLimited,
} from "../packages/shared/src/api.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import {
  PredecessorReset,
  type ResetExpectation,
} from "../apps/worker/src/predecessor-reset.ts";
import { createRequestHandler } from "../apps/worker/src/http-routes.ts";
import type { WorkerContext } from "../apps/worker/src/worker-context.ts";
import { withApiTiming } from "../packages/shared/src/api-timing.ts";
import { createScheduler } from "../apps/worker/src/worker-factories.ts";

const resources: { server: Server; db: BotDatabase }[] = [];
const schedulers: ReturnType<typeof createScheduler>[] = [];
afterEach(async () => {
  for (const scheduler of schedulers.splice(0)) scheduler.stop();
  for (const { server, db } of resources.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
  apiAccess.onRateLimit = () => {};
  apiAccess.onTransientFailure = () => {};
  apiAccess.onAttempt = () => {};
  apiAccess.onCircuitChange = () => {};
  apiAccess.onFailure = () => {};
  apiAccess.clearPairState();
  vi.restoreAllMocks();
});

async function fixture(error: string | null = "UPSTREAM_HTTP_429") {
  const db = new BotDatabase(":memory:");
  db.set("runtime", { ...db.runtime(), error, running: false });
  const cooldown = {
    api: "GeckoTerminal",
    exhausted: true,
    nextRetryAt: Date.now() + 3600000,
    circuitUntil: null,
  };
  if (error) db.set("api_cooldowns", [cooldown]);
  const bootId = randomUUID();
  const predecessorReset = new PredecessorReset(
    db,
    apiAccess,
    bootId,
    "SUI_USDC",
  );
  const healthy = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    {
      candles: async () => {
        throw Error("UNEXPECTED_MARKET_CALL");
      },
    },
    {
      getQuote: async () => {
        throw Error("UNEXPECTED_QUOTE_CALL");
      },
      validateQuote: async () => true,
    },
    { status: healthy, health: async () => healthy },
  );
  engine.monitor.boot();
  if (error) apiAccess.restoreCooldowns([cooldown]);
  predecessorReset.activate(engine.monitor);
  const ctx = {
    db,
    engine,
    predecessorReset,
    bootId,
    pair: "SUI_USDC",
    switching: false,
    stopping: false,
    browserSessions: {
      bearer: () => true,
      readonlyBearer: () => false,
      valid: () => false,
    },
    deploymentGate: { blocked: () => false },
    paperCheck: {
      status: () => ({ enabled: true, armed: true }),
      ordersAllowed: () => true,
    },
    sui: { status: healthy },
  } as unknown as WorkerContext;
  const handle = createRequestHandler(ctx);
  let upstreamStatus = 500;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/upstream/")) {
      res.writeHead(req.url === "/upstream/read" ? upstreamStatus : 200);
      res.end("{}");
      return;
    }
    void withApiTiming(() => handle(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push({ server, db });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function request(
    command?: string,
    expectedReset?: unknown,
    path = "/api/deployment",
  ) {
    const response = await fetch(base + (command ? "/api/control" : path), {
      method: command ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: command
        ? JSON.stringify({
            command,
            ...(expectedReset === undefined ? {} : { expectedReset }),
          })
        : undefined,
    });
    return { status: response.status, value: await response.json() };
  }
  const state = (await request()).value;
  const {
    eligible: _eligible,
    reason: _reason,
    pending: _pending,
    ...expected
  } = state.resetScope;
  return {
    ctx,
    base,
    recoverUpstream: () => {
      upstreamStatus = 200;
    },
    db,
    engine,
    predecessorReset,
    request,
    expected: expected as ResetExpectation,
  };
}

it("clears only the boot predecessor and cooldown, and safely acknowledges a lost-response retry", async () => {
  const t = await fixture();
  expect((await t.request("reset", t.expected)).status).toBe(200);
  expect(t.db.runtime()).toMatchObject({
    error: null,
    emergency: false,
    running: false,
  });
  expect(apiAccess.blocked()).toBe(false);
  const revision = t.db.runtimeRevision();
  expect((await t.request("reset", t.expected)).status).toBe(200);
  expect(t.db.runtimeRevision()).toBe(revision);
  expect(
    t.db
      .history<{ code: string }>("operation_events")
      .filter((e) => e.code === "MANUAL_RESET"),
  ).toHaveLength(1);
  expect((await t.request("start")).status).toBe(200);
  expect((await t.request("reset", t.expected)).status).toBe(409);
  expect(t.db.runtime().running).toBe(true);
});

it.each([false, true])(
  "keeps an emergency raised in the start window (reset already landed=%s)",
  async (landed) => {
    const t = await fixture();
    if (landed) {
      expect((await t.request("reset", t.expected)).status).toBe(200);
      expect((await t.request("start")).status).toBe(200);
    }
    expect((await t.request("emergency")).status).toBe(200);
    const before = t.db.runtime();
    expect(await t.request("reset", t.expected)).toMatchObject({
      status: 409,
      value: { error: "RESET_EMERGENCY_ACTIVE" },
    });
    expect((await t.request("reset")).status).toBe(409);
    expect((await t.request("start")).status).toBe(409);
    expect(t.db.runtime()).toEqual(before);
    expect(t.db.runtime().emergency).toBe(true);
  },
);

it.each([false, true])(
  "preserves a new 429 even when its error text matches the predecessor (reset landed=%s)",
  async (landed) => {
    const t = await fixture();
    if (landed) {
      expect((await t.request("reset", t.expected)).status).toBe(200);
      expect((await t.request("start")).status).toBe(200);
    }
    await expect(
      apiAccess.run("DeepBook Indexer", "fresh-429", async () => {
        throw new RateLimited("3600");
      }),
    ).rejects.toThrow();
    expect(t.db.runtime().error).toBe("UPSTREAM_HTTP_429");
    const before = apiAccess.snapshot();
    expect(await t.request("reset", t.expected)).toMatchObject({
      status: 409,
      value: { error: "RESET_SCOPE_CHANGED" },
    });
    expect((await t.request("reset")).status).toBe(409);
    expect(
      apiAccess.snapshot().map((s) => [s.api, s.exhausted, s.nextRetryAt]),
    ).toEqual(before.map((s) => [s.api, s.exhausted, s.nextRetryAt]));
    expect(apiAccess.blocked()).toBe(true);
    expect((await t.request("start")).status).toBe(409);
    expect(t.db.runtime().error).toBe("UPSTREAM_HTTP_429");
  },
);

it("rejects the wrong expected error, generation and boot without changing the old error", async () => {
  const t = await fixture("STALE_CANDLES");
  for (const change of [
    { expectedError: "UPSTREAM_HTTP_429" },
    { generation: "0".repeat(64) },
    { bootId: randomUUID() },
  ]) {
    expect(
      (await t.request("reset", { ...t.expected, ...change })).status,
    ).toBe(409);
    expect(t.db.runtime().error).toBe("STALE_CANDLES");
    expect(apiAccess.blocked()).toBe(true);
  }
});

it("detects a repeated identical error write, and does not reclassify a revisited pair as a predecessor", async () => {
  const t = await fixture("STALE_CANDLES");
  t.db.set("runtime", { ...t.db.runtime() });
  expect((await t.request("reset", t.expected)).status).toBe(409);
  const revisited = new PredecessorReset(
    t.db,
    apiAccess,
    t.expected.bootId,
    "SUI_USDC",
    false,
  );
  revisited.activate(t.engine.monitor);
  expect(revisited.clear()).toBe("RESET_NOT_PREDECESSOR");
  expect(t.db.runtime().error).toBe("STALE_CANDLES");
  const duringBoot = new PredecessorReset(
    t.db,
    apiAccess,
    randomUUID(),
    "SUI_USDC",
  );
  t.db.set("runtime", { ...t.db.runtime() });
  t.engine.monitor.boot();
  duringBoot.activate(t.engine.monitor);
  expect(duringBoot.clear()).toBe("RESET_SCOPE_CHANGED");
});

it("holds predecessor-blocked warmup until the scoped reset, without starting orders", async () => {
  const t = await fixture();
  t.ctx.chartHistory = { cancel: () => {} } as never;
  t.ctx.btcChartHistory = t.ctx.chartHistory;
  const tick = vi.spyOn(t.engine, "tick").mockResolvedValue();
  const cold = createScheduler(t.ctx);
  t.ctx.scheduler = cold;
  schedulers.push(cold);
  cold.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(tick).not.toHaveBeenCalled();
  expect((await t.request("reset", t.expected)).status).toBe(200);
  const warm = t.ctx.scheduler;
  expect(warm).not.toBe(cold);
  schedulers.push(warm);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(tick).toHaveBeenCalledTimes(1);
  expect(t.db.runtime().running).toBe(false);
});

async function currentStop() {
  const t = await fixture(null);
  apiAccess.onAttempt = ({ failure }) => {
    if (failure) t.engine.monitor.apiFailure(failure);
  };
  t.engine.monitor.beginCycle();
  const read = (path = "read") =>
    apiFetch("Test market", t.base + "/upstream/" + path);
  await expect(read()).rejects.toThrow("UPSTREAM_HTTP_500");
  t.engine.monitor.stop("UPSTREAM_HTTP_500", undefined, undefined, "HTTP 500");
  const scope = async () => {
    const state = await t.request(undefined, undefined, "/api/state");
    expect(state.status).toBe(200);
    return state.value.currentResetScope;
  };
  const recover = async () => {
    t.recoverUpstream();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await read();
  };
  return { ...t, scope, read, recover };
}

function expectation({
  version,
  bootId,
  pair,
  generation,
  expectedError,
}: ResetExpectation) {
  return { version, bootId, pair, generation, expectedError };
}

it("requires a later successful read of the failed route, then clears and audits without starting", async () => {
  const t = await currentStop();
  await t.read("different");
  const waiting = await t.scope();
  expect(waiting).toMatchObject({
    pending: true,
    eligible: false,
    reason: "RESET_BUSY",
  });
  expect((await t.request("reset-current", expectation(waiting))).status).toBe(
    409,
  );
  await t.recover();
  const ready = await t.scope();
  expect(ready).toMatchObject({ pending: true, eligible: true, reason: null });
  expect((await t.request("reset-current", expectation(waiting))).status).toBe(
    409,
  );
  expect((await t.request("reset-current", expectation(ready))).status).toBe(
    200,
  );
  expect(t.db.runtime()).toMatchObject({ running: false, error: null });
  expect(t.db.runtime()).not.toHaveProperty("failureDetail");
  expect(await t.scope()).toMatchObject({ pending: false, eligible: false });
  expect(
    t.db
      .history<{ code: string }>("operation_events")
      .filter((e) => e.code === "MANUAL_RESET"),
  ).toHaveLength(1);
  expect((await t.request("start")).status).toBe(200);
});

it.each(["wrong-error", "stale", "emergency", "running"])(
  "refuses current reset in the %s case",
  async (scenario) => {
    const t = await currentStop();
    await t.recover();
    const expected = expectation(await t.scope());
    if (scenario === "wrong-error")
      expected.expectedError = "UPSTREAM_HTTP_429";
    if (scenario === "stale") await t.request("stop");
    if (scenario === "emergency") await t.request("emergency");
    if (scenario === "running")
      t.db.set("runtime", { ...t.db.runtime(), running: true });
    const before = t.db.runtime();
    expect(await t.request("reset-current", expected)).toMatchObject({
      status: 409,
      value: {
        error:
          scenario === "emergency"
            ? "RESET_EMERGENCY_ACTIVE"
            : scenario === "running"
              ? "RESET_BUSY"
              : "RESET_SCOPE_CHANGED",
      },
    });
    expect(t.db.runtime()).toEqual(before);
  },
);

it("never uses the current route to clear an inherited HTTP 500", async () => {
  const t = await fixture("UPSTREAM_HTTP_500");
  const state = await t.request(undefined, undefined, "/api/state");
  expect(state.value.currentResetScope).toMatchObject({
    pending: false,
    eligible: false,
  });
  expect(
    (
      await t.request(
        "reset-current",
        expectation(state.value.currentResetScope),
      )
    ).status,
  ).toBe(409);
  expect(t.db.runtime().error).toBe("UPSTREAM_HTTP_500");
});

it("finishes connectivity checks before reset while keeping runtime stopped", async () => {
  const t = await currentStop();
  const monitor = t.engine.monitor;
  t.db.set("paper_safety", { ...monitor.safety(), connectivity: "DEGRADED" });
  await t.recover();
  expect(await t.scope()).toMatchObject({ eligible: false });
  const now = Date.now();
  monitor.market(now, now);
  monitor.beginCycle();
  expect(monitor.recoveryCycle({ market: true, sui: true }, now + 1_000)).toBe(
    false,
  );
  expect(monitor.safety().connectivity).toBe("RECOVERING");
  monitor.beginCycle();
  expect(monitor.recoveryCycle({ market: true, sui: true }, now + 62_000)).toBe(
    false,
  );
  expect(monitor.safety().connectivity).toBe("HEALTHY");
  expect(t.db.runtime()).toMatchObject({
    running: false,
    error: "UPSTREAM_HTTP_500",
  });
  expect(await t.scope()).toMatchObject({ eligible: true });
});
