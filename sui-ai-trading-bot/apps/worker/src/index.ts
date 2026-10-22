import { deepBookTransport } from "../../../packages/market-data/src/deepbook-transport.ts";
import { DashboardService, acceptsGzip } from "./dashboard-feed.ts";
import { gzip } from "node:zlib";
import { ChartHistoryClient } from "./chart-history-client.ts";
import { historyQuery } from "./chart-history.ts";
import { MarketScheduler } from "./scheduler.ts";
import {
  exportValidationReport,
  validationMarkdown,
} from "./validation-report.ts";
import { ValidationRecorder, assertValidationProfile } from "./validation.ts";
import { DeepBookMarketData } from "../../../packages/market-data/src/deepbook.ts";
import { MarketSelection } from "../../../packages/market-data/src/selection.ts";
import { apiAccess } from "../../../packages/shared/src/api.ts";
import "dotenv/config";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import { GeckoMarketData } from "../../../packages/market-data/src/index.ts";
import { CetusRouter } from "../../../packages/dex-router/src/index.ts";
import { ReadOnlySuiClient } from "../../../packages/sui-client/src/index.ts";
import { settingsSchema } from "../../../packages/shared/src/index.ts";
import { BotEngine } from "./engine.ts";
import { backtestMetadata, savedComparison } from "./backtest-service.ts";
import { comparisonOptionsSchema } from "../../../packages/backtest-engine/src/index.ts";
if (process.env.MODE && process.env.MODE !== "PAPER")
  throw new Error("ONLY_PAPER_SUPPORTED");
const token = process.env.ADMIN_TOKEN_FILE
  ? readFileSync(process.env.ADMIN_TOKEN_FILE, "utf8").trim()
  : process.env.ADMIN_TOKEN;
if (!token || token.length < 32)
  throw new Error("ADMIN_TOKEN must contain at least 32 characters");
const marketMode = process.env.MARKET_DATA_PROVIDER ?? "geckoterminal";
if (!["geckoterminal", "deepbook", "auto"].includes(marketMode))
  throw new Error("INVALID_MARKET_DATA_PROVIDER");
const reconstruction = process.env.DEEPBOOK_RECONSTRUCT_CANDLES ?? "off";
if (!["off", "verified"].includes(reconstruction))
  throw new Error("INVALID_DEEPBOOK_RECONSTRUCTION");
const validationEnabled = assertValidationProfile(process.env);
const db = new BotDatabase(process.env.DATABASE_PATH ?? "data/bot.sqlite");
const sui = new ReadOnlySuiClient(process.env.SUI_GRPC_URL),
  engine = new BotEngine(
    db,
    new MarketSelection(
      marketMode as "geckoterminal" | "deepbook" | "auto",
      new GeckoMarketData(process.env.MARKET_POOL || undefined),
      new DeepBookMarketData(
        () => db.settings(),
        undefined,
        reconstruction === "verified",
      ),
    ),
    new CetusRouter(),
    sui,
  );
// Monitoring boot closes the previous uptime segment and never resumes trading.
engine.monitor.boot();
const validation = validationEnabled ? new ValidationRecorder(db) : undefined;
engine.validation = validation;
validation?.boot();
apiAccess.onAttempt = (event) => {
  try {
    if (event.failure) engine.monitor.apiFailure(event.failure);
    if (
      event.success &&
      ["DeepBook Indexer", "GeckoTerminal"].includes(event.api)
    )
      engine.monitor.transportSuccess(event.occurredAt);
    validation?.attempt(event);
  } catch {
    try {
      validation?.fault("VALIDATION_RECORD_FAILED");
    } catch {}
    throw new Error("VALIDATION_RECORD_FAILED");
  }
};
validation?.sample(engine.marketStatus());
apiAccess.restoreCooldowns(db.get("api_cooldowns") ?? []);
let lastExportAt = 0;
function validationHeartbeat(final = false) {
  if (!validation) return;
  validation.sample(engine.marketStatus());
  const now = Date.now();
  if (
    process.env.VALIDATION_REPORT_DIR &&
    (final || now - lastExportAt >= 60000)
  ) {
    exportValidationReport(
      process.env.VALIDATION_REPORT_DIR,
      validation.report(now, true),
    );
    lastExportAt = now;
  }
}
// Log only allowlisted metadata; never raw errors, headers, bodies or credentials.
apiAccess.onFailure = (failure) =>
  console.warn(
    JSON.stringify({ event: "UPSTREAM_REQUEST_FAILED", ...failure }),
  );
const watchdog = setInterval(() => {
  try {
    engine.monitor.watchdog();
    validationHeartbeat();
  } catch {
    console.error("PAPER_MONITORING_UNAVAILABLE");
    process.exit(1);
  }
}, 15000);
watchdog.unref();
let stopping = false;
let backtestBusy = false;
let activeTick: Promise<void> | undefined;
const chartHistory = new ChartHistoryClient(
  (process.env.DATABASE_PATH ?? "data/bot.sqlite") + ".chart-history.sqlite",
  () => {
    const timing = engine.monitor.timing();
    return (
      !stopping &&
      !apiAccess.blocked() &&
      !apiAccess
        .snapshot()
        .some((a) => a.api === "DeepBook Indexer" && a.active) &&
      !timing.fetching &&
      (timing.nextFetchAt == null || timing.nextFetchAt - Date.now() > 12000)
    );
  },
);
const scheduler = new MarketScheduler(
  async () => {
    chartHistory.cancel();
    activeTick = engine.tick();
    await activeTick;
  },
  () => ({
    intervalMs: db.settings().intervalMs,
    deepbook:
      marketMode === "deepbook" ||
      (marketMode === "auto" &&
        engine.marketStatus()?.source !== "GeckoTerminal"),
    latestClosedAt: engine.monitor.state().lastMarketClosedAt,
    healthy: engine.marketStatus()?.healthy ?? false,
    blocked: apiAccess.blocked(),
  }),
  (plan) => engine.monitor.scheduled(plan?.at ?? null, plan?.reason ?? null),
  () => {
    console.error("PAPER_WORKER_UNAVAILABLE");
    process.exit(1);
  },
);
const dashboard = new DashboardService(engine, db);
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  );
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, value: unknown) => {
    const body = JSON.stringify(value);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Vary: "Accept-Encoding",
    };
    if (body.length > 1024 && acceptsGzip(req.headers["accept-encoding"])) {
      gzip(body, (error, buffer) => {
        if (res.destroyed) return;
        if (error) {
          res.destroy();
          return;
        }
        res.writeHead(status, {
          ...headers,
          "Content-Encoding": "gzip",
          "Content-Length": String(buffer.length),
        });
        res.end(buffer);
      });
    } else {
      res.writeHead(status, headers);
      res.end(body);
    }
  };
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      const healthy =
        Date.now() - engine.monitor.state().lastHeartbeatAt < 45000;
      send(healthy ? 200 : 503, {
        status: healthy ? "ok" : "stale",
        mode: "PAPER",
      });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") {
        send(405, { error: "METHOD" });
        return;
      }
      const root = resolve("apps/dashboard/dist"),
        file = resolve(
          root,
          "." + (url.pathname === "/" ? "/index.html" : url.pathname),
        );
      if (!file.startsWith(root + "\\") && !file.startsWith(root + "/")) {
        send(404, {});
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, {
        "Content-Type":
          (
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
      });
      res.end(data);
      return;
    }
    const supplied = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from("Bearer " + token);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      send(401, { error: "UNAUTHORIZED" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/chart/history") {
      try {
        const query = historyQuery(url.searchParams);
        const result = await chartHistory.get(
          query,
          db.candles(query.timeframe),
        );
        send(200, result);
      } catch (e) {
        const code = e instanceof Error ? e.message : "CHART_HISTORY_FAILED";
        send(code === "INVALID_CHART_RANGE" ? 400 : 503, {
          error: [
            "INVALID_CHART_RANGE",
            "CHART_BUSY",
            "CHART_CANCELLED",
            "CHART_CACHE_UNAVAILABLE",
          ].includes(code)
            ? code
            : "CHART_HISTORY_FAILED",
        });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/summary") {
      send(200, dashboard.summary());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/candles") {
      const tf = Number(url.searchParams.get("timeframe"));
      if (![300, 900, 3600].includes(tf)) {
        send(400, { error: "INVALID_CHART_TIMEFRAME" });
        return;
      }
      send(
        200,
        dashboard.candles(
          tf as 300 | 900 | 3600,
          url.searchParams.get("version"),
        ),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/records") {
      send(200, dashboard.records());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      send(200, engine.snapshot());
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/operations") {
      send(200, {
        ...engine.monitor.snapshot(),
        ...(validation ? { validation: validation.report() } : {}),
      });
      return;
    }
    if (
      validation &&
      req.method === "GET" &&
      ["/api/validation", "/api/validation/report.md"].includes(url.pathname)
    ) {
      const report = validation.report(Date.now(), true);
      if (url.pathname.endsWith(".md")) {
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
        res.end(validationMarkdown(report));
      } else send(200, report);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/balances") {
      if (!process.env.READ_ONLY_ADDRESS) {
        send(400, { error: "READ_ONLY_ADDRESS_UNSET" });
        return;
      }
      const { SUI, USDC } =
        await import("../../../packages/shared/src/index.ts");
      send(
        200,
        await Promise.all([
          sui.balance(process.env.READ_ONLY_ADDRESS, SUI),
          sui.balance(process.env.READ_ONLY_ADDRESS, USDC),
        ]),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/backtest") {
      send(200, backtestMetadata(db));
      return;
    }
    if (req.method !== "POST") {
      send(404, {});
      return;
    }
    // No cookies: browser cannot attach a bearer credential to cross-origin form requests.
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 16384) {
        send(413, {});
        return;
      }
    }
    const body = text ? JSON.parse(text) : {};
    if (validation && url.pathname === "/api/validation/start") {
      try {
        const report = validation.begin();
        validationHeartbeat(true);
        send(200, report);
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "VALIDATION_START_FAILED";
        send(409, {
          error: [
            "VALIDATION_ALREADY_STARTED",
            "STOP_BEFORE_VALIDATION",
            "PROFIT_GUARD_REQUIRED",
          ].includes(code)
            ? code
            : "VALIDATION_START_FAILED",
        });
      }
      return;
    }
    if (url.pathname === "/api/backtest") {
      if (backtestBusy) {
        send(409, { error: "BACKTEST_BUSY" });
        return;
      }
      const parsed = comparisonOptionsSchema.safeParse(body);
      if (!parsed.success) {
        send(400, { error: "INVALID_BACKTEST_OPTIONS" });
        return;
      }
      backtestBusy = true;
      try {
        const result = await savedComparison(db, parsed.data);
        send(200, result);
      } catch (error) {
        const allowed = new Set([
          "INSUFFICIENT_HISTORY_63_CANDLES",
          "INSUFFICIENT_WARMUP_61_CANDLES",
          "PERIOD_OUTSIDE_SAVED_HISTORY",
          "INSUFFICIENT_CANDLES",
          "INVALID_CANDLE",
          "CANDLE_GAP",
          "PRICE_OUTLIER",
          "MIXED_DATA_SOURCES",
        ]);
        send(400, {
          error:
            error instanceof Error && allowed.has(error.message)
              ? error.message
              : "BACKTEST_FAILED",
        });
      } finally {
        backtestBusy = false;
      }
      return;
    }
    if (url.pathname === "/api/settings") {
      const settings = settingsSchema.parse(body);
      db.updateSettings(settings);
      send(200, settings);
      return;
    }
    if (url.pathname === "/api/control") {
      const command = body.command;
      const r = db.runtime();
      if (command === "emergency")
        db.set("runtime", { ...r, running: false, emergency: true });
      else if (command === "stop") db.set("runtime", { ...r, running: false });
      else if (command === "reset") {
        apiAccess.reset();
        db.set("api_cooldowns", apiAccess.snapshot());
        db.set("runtime", {
          ...r,
          running: false,
          emergency: false,
          error: null,
        });
      } else if (command === "start") {
        const timing = engine.monitor.timing();
        if (timing.fetchElapsedMs != null && timing.fetchElapsedMs > 45000) {
          send(409, { error: "MARKET_FETCH_IN_PROGRESS" });
          return;
        }
        if (engine.monitor.safety().connectivity !== "HEALTHY") {
          send(409, { error: "PAPER_RECOVERY_REQUIRED" });
          return;
        }
        if (apiAccess.blocked()) {
          send(409, { error: "API_BACKOFF" });
          return;
        }
        if (r.emergency || r.error) {
          send(409, { error: "RESET_REQUIRED" });
          return;
        }
        if (!sui.status.healthy || Date.now() - sui.status.checkedAt > 180000) {
          send(409, { error: "HEALTH_CHECK_REQUIRED" });
          return;
        }
        if (!engine.monitor.ledger().ok) {
          send(409, { error: "ACCOUNTING_CHECK_REQUIRED" });
          return;
        }
        db.set("runtime", { ...r, running: true });
      } else {
        send(400, { error: "UNKNOWN_COMMAND" });
        return;
      }
      engine.monitor.transition(
        command === "start"
          ? "MANUAL_START"
          : command === "stop"
            ? "MANUAL_STOP"
            : command === "emergency"
              ? "EMERGENCY_STOP"
              : "MANUAL_RESET",
      );
      send(200, db.runtime());
      return;
    }
    send(404, { error: "NOT_FOUND" });
  } catch {
    send(400, { error: "REQUEST_FAILED" });
  }
});
server.listen(
  Number(process.env.PORT ?? 3100),
  process.env.HOST ?? "127.0.0.1",
  () => {
    console.info("PAPER dashboard/API ready");
    scheduler.start();
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    scheduler.stop();
    chartHistory.close();
    apiAccess.cancel();
    deepBookTransport.close();
    clearInterval(watchdog);
    db.set("runtime", { ...db.runtime(), running: false });
    engine.monitor.transition("PROCESS_SHUTDOWN");
    server.close(() => {
      void Promise.resolve(activeTick).finally(() => {
        try {
          validationHeartbeat(true);
          validation?.closed();
        } catch {
          console.error("VALIDATION_EXPORT_FAILED");
        }
        db.close();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 25000).unref();
  });
