// Isolated route harness: no scheduler, credentials, external APIs, or production DB.
// SOURCE_ROOT points at a git archive; both variants use identical timing probes.
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
const root = resolve(process.env.SOURCE_ROOT ?? ".");
const load = (p: string) => import(pathToFileURL(join(root, p)).href);
const { BotDatabase } = await load("packages/database/src/index.ts");
const { BotEngine } = await load("apps/worker/src/engine.ts");
const { ValidationRecorder } = await load("apps/worker/src/validation.ts");
const { DashboardService } = await load("apps/worker/src/dashboard-feed.ts");
const { withApiTiming, currentApiTiming, timeAggregation } = await load(
  "packages/shared/src/api-timing.ts",
);
const out = resolve(process.env.BENCH_OUT ?? "data/performance/current");
mkdirSync(out, { recursive: true });
const stamp = 1792700000000,
  start = stamp - 3600000;
Date.now = () => stamp;
const db = new BotDatabase(join(out, `fixture-${process.pid}.sqlite`));
const status = { healthy: true, checkedAt: stamp, failures: 0 };
const engine = new BotEngine(
  db,
  { candles: async () => [] },
  {
    getQuote: async () => {
      throw Error("NO_EXTERNAL_CALLS");
    },
    validateQuote: async () => false,
  },
  { health: async () => status, status },
);
let recorder = new ValidationRecorder(db),
  dashboard = new DashboardService(engine, db);
const scenario = process.env.BENCH_SCENARIO ?? "warm";
const count = Number(process.env.ROWS ?? 10000),
  n = Number(process.env.SAMPLES ?? 1000);
db.set("validation_session", {
  id: "fixed-session",
  startedAt: start,
  targetAt: start + 86400000,
  initialRunningMs: 0,
  initialEquity: 10000,
  intervalMs: 15000,
});
db.transaction(() => {
  for (let i = 0; i < count; i++) {
    const at = start + i,
      id = String(i).padStart(8, "0");
    const trade = {
      orderId: id,
      timestamp: at,
      side: "BUY",
      fee: "0",
      costs: { gasUsdc: "0", dexFeeUsdc: "0" },
    };
    db.append("paper_trades", id, trade, at);
    db.append(
      "paper_checks",
      id,
      {
        orderId: id,
        ok: true,
        expected: { ...db.portfolio(), tradeFee: "0", gasUsdc: "0" },
      },
      at,
    );
    db.append("paper_orders", id, { status: "REJECTED", timestamp: at }, at);
    db.append(
      "operation_candidates",
      id,
      {
        id,
        timestamp: at,
        finalAction: "WAIT",
        profitGuard: { evaluated: true, allowed: false },
        risk: { status: "REJECTED" },
      },
      at,
    );
  }
  for (let i = 0; i < 25000; i++)
    db.append(
      "validation_events",
      String(i).padStart(8, "0"),
      {
        kind: "api",
        at: start + i,
        data: {
          api: "DeepBook Indexer",
          occurredAt: start + i,
          attempt: 0,
          success: i % 100 !== 0,
          latencyMs: 100 + (i % 800),
          code: i % 100 === 0 ? "UPSTREAM_NETWORK_FAILED" : undefined,
        },
        safelyStopped: true,
      },
      start + i,
    );
});
for (const tf of [300, 900, 3600])
  db.saveCandles(
    Array.from({ length: 1000 }, (_, i) => ({
      timeframe: tf,
      timestamp: Math.floor(stamp / 1000 / tf) * tf - (1000 - i) * tf,
      open: 2,
      high: 2.1,
      low: 1.9,
      close: 2,
      volume: 100,
      source: "fixture",
    })),
  );
const routes: Record<string, () => unknown> = {
  "/api/operations": () => ({
    ...engine.monitor.snapshot(),
    validation: recorder.report(),
  }),
  "/api/validation": () => recorder.report(stamp, true),
  "/api/dashboard/summary": () => dashboard.summary(),
};
const spans: Record<string, Record<string, number>[]> = {};
const hashes: Record<string, string> = {};
const zip = promisify(gzip);
const server = createServer((req, res) =>
  withApiTiming(async () => {
    try {
      if (scenario === "cold") {
        recorder = new ValidationRecorder(db);
        dashboard = new DashboardService(engine, db);
      }
      const route = req.url!,
        value = timeAggregation(routes[route]),
        t = currentApiTiming()!;
      let began = performance.now();
      const body = JSON.stringify(value);
      t.jsonMs = performance.now() - began;
      hashes[route] = createHash("sha256").update(body).digest("hex");
      began = performance.now();
      const buffer = await zip(body);
      t.compressionMs = performance.now() - began;
      (spans[route] ??= []).push({ ...t });
      res.writeHead(200, {
        "Content-Encoding": "gzip",
        "Content-Length": buffer.length,
      });
      res.end(buffer);
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  }),
);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const get = (path: string) =>
  new Promise<number>((ok, fail) => {
    const began = performance.now();
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        headers: { "Accept-Encoding": "gzip" },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          res.statusCode === 200
            ? ok(performance.now() - began)
            : fail(Error(`HTTP ${res.statusCode}`)),
        );
      },
    );
    req.on("error", fail);
    req.end();
  });
const quantiles = (a: number[]) => {
  const s = [...a].sort((a, b) => a - b);
  return {
    p50: s[Math.ceil(s.length * 0.5) - 1],
    p95: s[Math.ceil(s.length * 0.95) - 1],
    p99: s[Math.ceil(s.length * 0.99) - 1],
    max: s.at(-1),
    mean: s.reduce((a, b) => a + b, 0) / s.length,
  };
};
const results: Record<string, unknown> = {};
try {
  for (const route of Object.keys(routes)) {
    for (let i = 0; i < 10; i++) await get(route);
    spans[route] = [];
    const durations = [];
    for (let i = 0; i < n; i++) {
      durations.push(await get(route));
      if (i % 200 === 199) console.log(`${root} ${route} ${i + 1}/${n}`);
    }
    const phase = Object.fromEntries(
      Object.keys(spans[route][0]).map((k) => [
        k,
        quantiles(spans[route].map((s) => s[k])),
      ]),
    );
    results[route] = {
      n,
      latencyMs: quantiles(durations),
      phase,
      sha256: hashes[route],
    };
  }
  writeFileSync(
    join(out, "results.json"),
    JSON.stringify(
      {
        root,
        node: process.version,
        scenario,
        count,
        validationEvents: 25000,
        candles: 3000,
        concurrency: 1,
        frozenTime: stamp,
        results,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(out, "raw.json"), JSON.stringify(spans));
} finally {
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
}
