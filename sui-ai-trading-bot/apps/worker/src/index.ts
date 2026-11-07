import { PaperCheckSession } from "./paper-check-session.ts";
import "../../../scripts/enforce-node-version.mjs";
import { runtimeBuild } from "./runtime-build.ts";
import {
  acquireInstanceLock,
  DeploymentGate,
  recordLifecycle,
} from "./deployment-safety.ts";
import {
  existingPaperDatabases,
  assertInitializedPaperState,
} from "./paper-database-inventory.ts";
import { withApiTiming } from "../../../packages/shared/src/api-timing.ts";
import { deepBookTransport } from "../../../packages/market-data/src/deepbook-transport.ts";
import { DashboardService } from "./dashboard-feed.ts";
import { startDisplaySamplers } from "./display-samplers.ts";
import { WorkerContext } from "./worker-context.ts";
import { createRequestHandler } from "./http-routes.ts";
import {
  createChartHistory,
  createEngine,
  createScheduler,
  validationHeartbeat,
} from "./worker-factories.ts";
import { ValidationRecorder, assertValidationProfile } from "./validation.ts";
import { apiAccess } from "../../../packages/shared/src/api.ts";
import "dotenv/config";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { BrowserSessions } from "./browser-session.ts";
import { readFileSync } from "node:fs";
import { dirname, basename } from "node:path";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import {
  tradingPair,
  type TradingPair,
} from "../../../packages/shared/src/index.ts";
import { resolveSuiGrpcEndpoints } from "./suiEndpoints.ts";
if (process.env.MODE && process.env.MODE !== "PAPER")
  throw new Error("ONLY_PAPER_SUPPORTED");
const token = process.env.ADMIN_TOKEN_FILE
  ? readFileSync(process.env.ADMIN_TOKEN_FILE, "utf8").trim()
  : process.env.ADMIN_TOKEN;
if (!token || token.length < 32)
  throw new Error("ADMIN_TOKEN must contain at least 32 characters");
const browserSessions = new BrowserSessions(token);
const marketMode = process.env.MARKET_DATA_PROVIDER ?? "geckoterminal";
if (!["geckoterminal", "deepbook", "auto"].includes(marketMode))
  throw new Error("INVALID_MARKET_DATA_PROVIDER");
const reconstruction = process.env.DEEPBOOK_RECONSTRUCT_CANDLES ?? "off";
if (!["off", "verified"].includes(reconstruction))
  throw new Error("INVALID_DEEPBOOK_RECONSTRUCTION");
const validationEnabled = assertValidationProfile(process.env);
const instanceLock = acquireInstanceLock(
  process.env.DATABASE_PATH ?? "data/bot.sqlite",
);
// This connection intentionally stays open until exit, never before thread exit.
const rootDatabasePath = instanceLock.root;
if (![undefined, "0", "1"].includes(process.env.REQUIRE_EXISTING_DATABASE))
  throw Error("INVALID_REQUIRE_EXISTING_DATABASE");
if (process.env.REQUIRE_EXISTING_DATABASE === "1") {
  const names = existingPaperDatabases(
    dirname(rootDatabasePath),
    basename(rootDatabasePath),
  );
  if (process.env.TRADING_PAIR) {
    const requested = tradingPair(process.env.TRADING_PAIR);
    const expected =
      basename(rootDatabasePath) +
      (requested === "WAL_USDC" ? ".WAL_USDC.sqlite" : "");
    if (!names.has(expected)) throw Error("EXISTING_DATABASE_REQUIRED");
  }
  assertInitializedPaperState(
    dirname(rootDatabasePath),
    basename(rootDatabasePath),
    names,
  );
}
const deploymentGate = new DeploymentGate(rootDatabasePath);
const paperCheck = new PaperCheckSession(process.env.PAPER_CHECK_MODE);
const bootId = randomUUID();
recordLifecycle(rootDatabasePath, bootId, "running");
const selectionDb = new BotDatabase(rootDatabasePath + ".pairs.sqlite");
const pair = tradingPair(
  process.env.TRADING_PAIR ?? selectionDb.get("selected_pair") ?? "SUI_USDC",
);
if (!paperCheck.pairAllowed(pair)) throw Error("PAPER_CHECK_PAIR_FORBIDDEN");
const pairPath = (value: TradingPair) =>
  value === "SUI_USDC"
    ? rootDatabasePath
    : rootDatabasePath + ".WAL_USDC.sqlite";
const db = new BotDatabase(pairPath(pair));
db.set(
  "runtime_build",
  runtimeBuild(
    process.env,
    readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"),
  ),
);
const suiGrpcEndpoints = resolveSuiGrpcEndpoints();
const ctx = new WorkerContext({
  browserSessions,
  deploymentGate,
  paperCheck,
  selectionDb,
  rootDatabasePath,
  bootId,
  marketMode,
  reconstruction,
  validationEnabled,
  suiGrpcEndpoints,
  pair,
  db,
  samplers: startDisplaySamplers(suiGrpcEndpoints),
});
const created = createEngine(ctx, db, pair);
ctx.sui = created.sui;
ctx.engine = created.engine;
// Monitoring boot closes the previous uptime segment and never resumes trading.
ctx.engine.monitor.boot();
ctx.validation = validationEnabled ? new ValidationRecorder(db) : undefined;
ctx.engine.validation = ctx.validation;
ctx.validation?.boot();
apiAccess.onAttempt = (event) => {
  try {
    if (event.failure) ctx.engine.monitor.apiFailure(event.failure);
    if (
      event.success &&
      ["DeepBook Indexer", "GeckoTerminal"].includes(event.api)
    )
      ctx.engine.monitor.transportSuccess(event.occurredAt);
    ctx.validation?.attempt(event);
  } catch {
    try {
      ctx.validation?.fault("VALIDATION_RECORD_FAILED");
    } catch {}
    throw new Error("VALIDATION_RECORD_FAILED");
  }
};
ctx.validation?.sample(ctx.engine.marketStatus());
apiAccess.restoreCooldowns(ctx.db.get("api_cooldowns") ?? []);
ctx.predecessorReset.activate(ctx.engine.monitor);
apiAccess.onCircuitChange = () =>
  ctx.db.set("api_cooldowns", apiAccess.snapshot());
// Log only allowlisted metadata; never raw errors, headers, bodies or credentials.
apiAccess.onFailure = (failure) =>
  console.warn(
    JSON.stringify({ event: "UPSTREAM_REQUEST_FAILED", ...failure }),
  );
const watchdog = setInterval(() => {
  try {
    ctx.engine.monitor.watchdog();
    validationHeartbeat(ctx);
  } catch {
    console.error(
      JSON.stringify({
        event: "PAPER_MONITORING_UNAVAILABLE",
        databaseHealth: ctx.db.health(),
      }),
    );
    process.exit(1);
  }
}, 15000);
watchdog.unref();
ctx.chartHistory = createChartHistory(ctx);
ctx.scheduler = createScheduler(ctx);
ctx.dashboard = new DashboardService(ctx.engine, ctx.db);
const handleRequest = createRequestHandler(ctx);
const server = createServer((req, res) => {
  ctx.inFlightRequests++;
  void withApiTiming(() => handleRequest(req, res)).finally(() => {
    ctx.inFlightRequests--;
  });
});
server.listen(
  Number(process.env.PORT ?? 3100),
  process.env.HOST ?? "127.0.0.1",
  () => {
    console.info("PAPER dashboard/API ready");
    ctx.scheduler.start();
  },
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (ctx.stopping) return;
    ctx.stopping = true;
    ctx.engine.monitor.beginShutdown();
    ctx.scheduler.stop();
    const chartClosed = ctx.chartHistory.close();
    apiAccess.cancel();
    deepBookTransport.close();
    clearInterval(watchdog);
    clearInterval(ctx.chainTimer);
    ctx.db.set("runtime", { ...ctx.db.runtime(), running: false });
    ctx.engine.monitor.transition("PROCESS_SHUTDOWN");
    server.close(() => {
      void Promise.all([ctx.activeTick, chartClosed])
        .then(() => {
          try {
            validationHeartbeat(ctx, true);
            ctx.validation?.closed();
            ctx.sui.close();
            ctx.db.close();
            ctx.selectionDb.close();
            recordLifecycle(ctx.rootDatabasePath, ctx.bootId, "clean");
            process.exit(0);
          } catch {
            console.error("PAPER_SHUTDOWN_INCOMPLETE");
            process.exit(1);
          }
        })
        .catch(() => {
          console.error("PAPER_SHUTDOWN_INCOMPLETE");
          process.exit(1);
        });
    });
    setTimeout(() => process.exit(1), 25000).unref();
  });
