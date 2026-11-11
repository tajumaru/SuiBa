import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BotDatabase } from "../packages/database/src/index.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { PredecessorReset } from "../apps/worker/src/predecessor-reset.ts";
import { createRequestHandler } from "../apps/worker/src/http-routes.ts";
import type { WorkerContext } from "../apps/worker/src/worker-context.ts";
import { withApiTiming } from "../packages/shared/src/api-timing.ts";

// Cache policy per path class: Vite fingerprints everything under
// /assets/ (content hash in the filename), so those responses are
// immutable-cacheable; index.html and every /api/ response must stay
// no-store so a deploy takes effect immediately and live data is
// never served from a browser cache.
const ASSET_NAME = "index-cachehdr0.js";
const distRoot = resolve("apps/dashboard/dist");
const createdFiles: string[] = [];
const createdDirs: string[] = [];
let server: Server;
let db: BotDatabase;
let base = "";

async function writeIfAbsent(path: string, content: string) {
  try {
    await writeFile(path, content, { flag: "wx" });
    createdFiles.push(path);
  } catch {
    // A real build output is already there; serve and assert on it.
  }
}

beforeAll(async () => {
  if (!existsSync(distRoot)) {
    await mkdir(distRoot, { recursive: true });
    createdDirs.push(distRoot);
  }
  const assetsDir = resolve(distRoot, "assets");
  if (!existsSync(assetsDir)) {
    await mkdir(assetsDir, { recursive: true });
    createdDirs.push(assetsDir);
  }
  await writeIfAbsent(resolve(distRoot, "index.html"), "<!doctype html><title>cache</title>");
  await writeIfAbsent(resolve(assetsDir, ASSET_NAME), "export {};\n");

  db = new BotDatabase(":memory:");
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
  server = createServer((req, res) => {
    void withApiTiming(() => handle(req, res));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  db.close();
  apiAccess.onRateLimit = () => {};
  apiAccess.onTransientFailure = () => {};
  apiAccess.onAttempt = () => {};
  apiAccess.onCircuitChange = () => {};
  apiAccess.onFailure = () => {};
  apiAccess.clearPairState();
  vi.restoreAllMocks();
  for (const file of createdFiles.splice(0)) await rm(file, { force: true });
  for (const dir of createdDirs.splice(0).reverse()) {
    await rmdir(dir).catch(() => {});
  }
});

it("serves fingerprinted /assets/ files with an immutable year-long cache", async () => {
  const response = await fetch(`${base}/assets/${ASSET_NAME}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
  // The handler-wide security headers are untouched by the override.
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  await response.text();
});

it("keeps index.html at no-store so a deploy takes effect at once", async () => {
  for (const path of ["/", "/index.html"]) {
    const response = await fetch(base + path);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await response.text();
  }
});

it("keeps /api/ responses at no-store", async () => {
  const response = await fetch(base + "/api/pairs");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  await response.json();
});
