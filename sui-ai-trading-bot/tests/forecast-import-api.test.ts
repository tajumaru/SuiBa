import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { createRequestHandler } from "../apps/worker/src/http-routes.ts";
import { withApiTiming } from "../packages/shared/src/api-timing.ts";
import type { WorkerContext } from "../apps/worker/src/worker-context.ts";
import { readForecast } from "../apps/worker/src/forecast.ts";

const db = new BotDatabase(":memory:");
const context = {
  db,
  pair: "SUI_USDC",
  stopping: false,
  switching: false,
  browserSessions: {
    bearer: (req: { headers: { authorization?: string } }) =>
      req.headers.authorization === "Bearer fixture",
    readonlyBearer: () => false,
    valid: () => false,
  },
  deploymentGate: { blocked: () => false },
} as unknown as WorkerContext;
const handler = createRequestHandler(context);
const server = createServer((req, res) => {
  void withApiTiming(() => handler(req, res));
});
let base = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/forecast/import`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});
const headers = {
  Authorization: "Bearer fixture",
  "Content-Type": "application/json",
  "X-SuiBa-Pair": "SUI_USDC",
};
const f = JSON.parse(
  readFileSync(
    new URL("./fixtures/forecast-legacy-ae9483a.json", import.meta.url),
    "utf8",
  ),
).fixtures[1];
const payload = { records: f.records, calib: { scale: 1.16, scoredAt: 30 } };
it("authenticates and imports a real legacy payload larger than the normal mutation limit, once", async () => {
  const body = JSON.stringify(payload);
  expect(body.length).toBeGreaterThan(16384);
  expect(
    (
      await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      })
    ).status,
  ).toBe(401);
  const first = await fetch(base, { method: "POST", headers, body });
  expect(first.status).toBe(200);
  const receipt = await first.json();
  const retry = await fetch(base, { method: "POST", headers, body });
  expect(await retry.json()).toEqual(receipt);
  expect(db.history("forecast_imports")).toHaveLength(1);
  expect(readForecast(db, "SUI_USDC").calib).toEqual(payload.calib);
});
it("rejects stale pair headers and invalid or oversized migration data", async () => {
  expect(
    (
      await fetch(base, {
        method: "POST",
        headers: { ...headers, "X-SuiBa-Pair": "WAL_USDC" },
        body: JSON.stringify(payload),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ records: [], calib: { scale: 8, scoredAt: 0 } }),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ padding: "x".repeat(600001) }),
      })
    ).status,
  ).toBe(413);
  expect(readForecast(db, "SUI_USDC").calib.scale).toBe(1.16);
});
