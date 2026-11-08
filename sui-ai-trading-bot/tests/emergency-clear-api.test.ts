import { afterEach, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { BotDatabase } from "../packages/database/src/index.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { PredecessorReset } from "../apps/worker/src/predecessor-reset.ts";
import { createRequestHandler } from "../apps/worker/src/http-routes.ts";
import type { WorkerContext } from "../apps/worker/src/worker-context.ts";
import { withApiTiming } from "../packages/shared/src/api-timing.ts";

// The dedicated owner release for an owner-latched emergency stop.
// The scoped reset refuses emergencies by contract (PR #105); this
// command is the only path that clears one, and it must clear ONLY
// the emergency flag.
const resources: { server: Server; db: BotDatabase }[] = [];
afterEach(async () => {
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

async function fixture(runtime: Record<string, unknown>) {
  const db = new BotDatabase(":memory:");
  db.set("runtime", { ...db.runtime(), running: false, ...runtime });
  const predecessorReset = new PredecessorReset(db, apiAccess, randomUUID(), "SUI_USDC");
  const healthy = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => { throw Error("UNEXPECTED_MARKET_CALL"); } },
    {
      getQuote: async () => { throw Error("UNEXPECTED_QUOTE_CALL"); },
      validateQuote: async () => true,
    },
    { status: healthy, health: async () => healthy },
  );
  engine.monitor.boot();
  predecessorReset.activate(engine.monitor);
  const ctx = {
    db,
    engine,
    predecessorReset,
    bootId: randomUUID(),
    pair: "SUI_USDC",
    switching: false,
    stopping: false,
    browserSessions: { bearer: () => true, valid: () => false },
    deploymentGate: { blocked: () => false },
    paperCheck: {
      status: () => ({ enabled: true, armed: true }),
      ordersAllowed: () => true,
    },
    sui: { status: healthy },
  } as unknown as WorkerContext;
  const handle = createRequestHandler(ctx);
  const server = createServer((req, res) => {
    void withApiTiming(() => handle(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  resources.push({ server, db });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function control(body: Record<string, unknown>) {
    const response = await fetch(base + "/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  }
  return { db, control };
}

it("clears a latched emergency with the confirm string, and nothing else", async () => {
  const { db, control } = await fixture({ emergency: true, error: "UPSTREAM_HTTP_500" });
  const res = await control({ command: "clear-emergency", confirm: "CLEAR-EMERGENCY" });
  expect(res.status).toBe(200);
  expect(db.runtime().emergency).toBe(false);
  // The latched error keeps its own release path; running stays off.
  expect(db.runtime().error).toBe("UPSTREAM_HTTP_500");
  expect(db.runtime().running).toBe(false);
});

it("refuses without the confirm string and stays latched", async () => {
  const { db, control } = await fixture({ emergency: true });
  const res = await control({ command: "clear-emergency" });
  expect(res.status).toBe(400);
  expect(res.value).toMatchObject({ error: "EMERGENCY_CLEAR_CONFIRM_REQUIRED" });
  expect(db.runtime().emergency).toBe(true);
});

it("refuses while the bot is running", async () => {
  const { db, control } = await fixture({ emergency: true });
  // boot() always lands stopped, so set the (defensive) state directly:
  // the guard must hold even if the invariant ever changes.
  db.set("runtime", { ...db.runtime(), running: true });
  const res = await control({ command: "clear-emergency", confirm: "CLEAR-EMERGENCY" });
  expect(res.status).toBe(409);
  expect(res.value).toMatchObject({ error: "EMERGENCY_CLEAR_RUNNING" });
  expect(db.runtime().emergency).toBe(true);
});

it("refuses when no emergency is latched", async () => {
  const { control } = await fixture({ emergency: false });
  const res = await control({ command: "clear-emergency", confirm: "CLEAR-EMERGENCY" });
  expect(res.status).toBe(409);
  expect(res.value).toMatchObject({ error: "EMERGENCY_NOT_ACTIVE" });
});

it("the scoped reset still refuses an emergency (PR #105 contract)", async () => {
  const { db, control } = await fixture({ emergency: true, error: "UPSTREAM_HTTP_429" });
  const res = await control({ command: "reset" });
  expect(res.status).toBe(409);
  expect(res.value).toMatchObject({ error: "RESET_EMERGENCY_ACTIVE" });
  expect(db.runtime().emergency).toBe(true);
});
