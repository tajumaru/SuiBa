import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { BrowserSessions } from "../apps/worker/src/browser-session.ts";
import { createRequestHandler } from "../apps/worker/src/http-routes.ts";
import type { WorkerContext } from "../apps/worker/src/worker-context.ts";
import { withApiTiming } from "../packages/shared/src/api-timing.ts";

const adminToken = randomBytes(32).toString("hex");
const readonlyToken = randomBytes(32).toString("hex");
const sessions = new BrowserSessions(adminToken, readonlyToken);
let server: Server;
let base = "";

beforeAll(async () => {
  const ctx = {
    browserSessions: sessions,
    pair: "SUI_USDC",
    switching: false,
  } as unknown as WorkerContext;
  const handle = createRequestHandler(ctx);
  server = createServer((req, res) => {
    void withApiTiming(() => handle(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const request = (token: string, method = "GET", headers = {}) =>
  fetch(base + "/api/pairs", {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });

it("allows a matching read-only bearer through the shared GET route", async () => {
  const response = await request(readonlyToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ selected: "SUI_USDC" });
});

it("rejects mutations made with only the read-only bearer", async () => {
  const response = await request(readonlyToken, "POST");
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "FORBIDDEN" });
});

it("returns unauthorized for a non-matching bearer", async () => {
  const response = await request(randomBytes(32).toString("hex"));
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
});

it("disables read-only access when no token is configured", () => {
  const disabled = new BrowserSessions(adminToken);
  const req = {
    headers: { authorization: `Bearer ${readonlyToken}` },
  } as Parameters<BrowserSessions["readonlyBearer"]>[0];
  expect(disabled.readonlyBearer(req)).toBe(false);
});

it("keeps master bearer and cookie authentication behavior", async () => {
  expect((await request(adminToken)).status).toBe(200);
  expect((await request(adminToken, "POST")).status).toBe(400);

  const cookie = `suiba.session=${sessions.issue()}`;
  const response = await fetch(base + "/api/pairs", {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
});

it("does not bypass the existing pair guard", async () => {
  const response = await request(readonlyToken, "GET", {
    "X-SuiBa-Pair": "WAL_USDC",
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "PAIR_CHANGED" });
});
