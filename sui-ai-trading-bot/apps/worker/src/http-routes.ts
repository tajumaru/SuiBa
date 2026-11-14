import { importForecast } from "./forecast.ts";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { gzip } from "node:zlib";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DashboardService, acceptsGzip } from "./dashboard-feed.ts";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import { ValidationRecorder } from "./validation.ts";
import { sessionMutationAllowed } from "./browser-session.ts";
import { historyQuery } from "./chart-history.ts";
import { runtimeBuild } from "./runtime-build.ts";
import { validationMarkdown } from "./validation-report.ts";
import { backtestMetadata, savedComparison } from "./backtest-service.ts";
import {
  createChartHistory,
  createEngine,
  createScheduler,
  validationHeartbeat,
} from "./worker-factories.ts";
import {
  currentApiTiming,
  timeAggregation,
  timingHeader,
} from "../../../packages/shared/src/api-timing.ts";
import { apiAccess } from "../../../packages/shared/src/api.ts";
import {
  settingsSchema,
  tradingPairs,
} from "../../../packages/shared/src/index.ts";
import { comparisonOptionsSchema } from "../../../packages/backtest-engine/src/index.ts";
import type { WorkerContext } from "./worker-context.ts";
import { PredecessorReset } from "./predecessor-reset.ts";
import { shadowTodaySummary } from "./shadow-summary.ts";

/**
 * The HTTP request handler, extracted from the worker boot:
 * security headers and response timing/gzip, the static
 * dashboard files, session/bearer auth, and every /api route
 * (deployment, pairs incl. the pair switch, chart history,
 * the dashboard feed channels, operations, validation,
 * balances, backtest, settings, control). It reads and
 * reassigns the live state through the WorkerContext, so the
 * pair switch it performs is the same one the boot script's
 * handler always performed.
 */
export function createRequestHandler(ctx: WorkerContext) {
  return async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  );
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, value: unknown) => {
    const timing = currentApiTiming()!;
    const jsonStart = performance.now();
    const body = JSON.stringify(value);
    timing.jsonMs += performance.now() - jsonStart;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Vary: "Accept-Encoding",
    };
    if (body.length > 1024 && acceptsGzip(req.headers["accept-encoding"])) {
      const compressionStart = performance.now();
      gzip(body, (error, buffer) => {
        timing.compressionMs += performance.now() - compressionStart;
        if (res.destroyed) return;
        if (error) {
          res.destroy();
          return;
        }
        res.writeHead(status, {
          ...headers,
          "Server-Timing": timingHeader(timing),
          "Content-Encoding": "gzip",
          "Content-Length": String(buffer.length),
        });
        res.end(buffer);
      });
    } else {
      res.writeHead(status, {
        ...headers,
        "Server-Timing": timingHeader(timing),
      });
      res.end(body);
    }
  };
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      const healthy =
        Date.now() - ctx.engine.monitor.state().lastHeartbeatAt < 45000;
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
      // Vite fingerprints everything under /assets/ (the filename
      // carries a content hash), so those responses can be cached
      // forever: a new build produces new filenames. index.html, the
      // root icons and version.json are not fingerprinted and keep
      // the handler-wide no-store, so a deploy takes effect at once
      // and the update check never reads a stale version file.
      if (url.pathname.startsWith("/assets/")) {
        res.setHeader(
          "Cache-Control",
          "public, max-age=31536000, immutable",
        );
      }
      res.writeHead(200, {
        "Content-Type":
          (
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
              ".webp": "image/webp",
              ".png": "image/png",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
      });
      res.end(data);
      return;
    }
    const bearer = ctx.browserSessions.bearer(req);
    const session = ctx.browserSessions.valid(req.headers.cookie);
    const readonlyBearer = ctx.browserSessions.readonlyBearer(req);
    if (!bearer && !session && !readonlyBearer) {
      send(401, { error: "UNAUTHORIZED" });
      return;
    }
    if (req.method !== "GET" && !bearer && !session && readonlyBearer) {
      send(403, { error: "FORBIDDEN" });
      return;
    }
    if (req.method !== "GET" && !bearer && !sessionMutationAllowed(req)) {
      send(403, { error: "FORBIDDEN" });
      return;
    }
    if (url.pathname === "/api/auth/session") {
      if (req.method === "POST") {
        ctx.browserSessions.setCookie(req, res);
      } else if (req.method === "DELETE") {
        ctx.browserSessions.setCookie(req, res, true);
      } else if (req.method !== "GET") {
        send(405, { error: "METHOD" });
        return;
      }
      send(200, { authenticated: true });
      return;
    }
    if (req.headers["x-suiba-pair"] && req.headers["x-suiba-pair"] !== ctx.pair) {
      send(409, { error: "PAIR_CHANGED" });
      return;
    }
    if (ctx.switching) {
      send(409, { error: "PAIR_SWITCH_IN_PROGRESS" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/deployment") {
      const build = ctx.db.get<{ declaredSha: string | null; lockSha256: string }>(
        "runtime_build",
      );
      send(200, {
        mode: "PAPER",
        maintenance: ctx.stopping || ctx.deploymentGate.blocked(),
        running: ctx.db.runtime().running,
        revision: build?.declaredSha ?? null,
        lockSha256: build?.lockSha256 ?? null,
        databaseHealthy: ctx.db.health().healthy,
        ledgerOk: ctx.engine.monitor.ledger().ok,
        paperCheck: ctx.paperCheck.status(),
        resetScope: ctx.predecessorReset.status(),
        shadow:
          process.env.SUIBA_SHADOW_ENABLED === "true"
            ? shadowTodaySummary(ctx.db)
            : null,
        ...(() => {
          const readiness = {
            connectivity: ctx.engine.monitor.safety().connectivity === "HEALTHY",
            apiAccess: !apiAccess.blocked(),
            emergencyClear: !ctx.db.runtime().emergency,
            runtimeClear: !ctx.db.runtime().error,
            suiHealthy: ctx.sui.status.healthy,
            suiFresh: Date.now() - ctx.sui.status.checkedAt <= 180000,
            ledger: ctx.engine.monitor.ledger().ok,
          };
          return {
            readiness,
            startReady: Object.values(readiness).every(Boolean),
          };
        })(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/pairs") {
      send(200, {
        selected: ctx.pair,
        pairs: Object.keys(tradingPairs),
        mode: "PAPER",
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/chart/history") {
      try {
        const query = historyQuery(url.searchParams);
        const result = await ctx.chartHistory.get(
          query,
          ctx.db.candles(query.timeframe),
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
      send(
        200,
        timeAggregation(() => ctx.dashboard.summary()),
      );
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
        timeAggregation(() =>
          ctx.dashboard.candles(
            tf as 300 | 900 | 3600,
            url.searchParams.get("version"),
          ),
        ),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/records") {
      send(
        200,
        timeAggregation(() => ctx.dashboard.records()),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard/long-term") {
      send(
        200,
        timeAggregation(() => ctx.dashboard.longTerm()),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      send(
        200,
        timeAggregation(() => ctx.engine.snapshot()),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/operations") {
      send(200, {
        ...timeAggregation(() => ctx.engine.monitor.snapshot()),
        // The effective execution environment, for the operations
        // view and the diagnostic export: a configuration mistake
        // (wrong pair, provider or paper-check token) should be
        // visible in the app, not only in host-side checks.
        environment: {
          mode: "PAPER",
          pair: ctx.engine.pair,
          provider: ctx.engine.marketStatus()?.source ?? null,
          paperCheck: ctx.paperCheck.status(),
          maintenance: ctx.stopping || ctx.deploymentGate.blocked(),
        },
        databaseHealth: ctx.db.health(),
        suiHealth: { ...ctx.sui.status },
        suiReads: { ...ctx.sui.readStatus },
        suiObservations: ctx.db.history("sui_observations", 50),
        ...(ctx.validation
          ? { validation: timeAggregation(() => ctx.validation!.report()) }
          : {}),
      });
      return;
    }
    if (
      ctx.validation &&
      req.method === "GET" &&
      ["/api/validation", "/api/validation/report.md"].includes(url.pathname)
    ) {
      const report = timeAggregation(() =>
        ctx.validation!.report(Date.now(), true),
      );
      if (url.pathname.endsWith(".md")) {
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
        });
        res.end(validationMarkdown(report));
      } else send(200, report);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/balances") {
      if (!process.env.READ_ONLY_ADDRESS) {
        send(400, { error: "READ_ONLY_ADDRESS_UNSET" });
        return;
      }
      const { USDC } = await import("../../../packages/shared/src/index.ts");
      send(
        200,
        await Promise.all([
          ctx.sui.balance(process.env.READ_ONLY_ADDRESS, tradingPairs[ctx.pair].base),
          ctx.sui.balance(process.env.READ_ONLY_ADDRESS, USDC),
        ]),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/backtest") {
      send(200, backtestMetadata(ctx.db));
      return;
    }
    if (req.method !== "POST") {
      send(404, {});
      return;
    }
    // Cookie-authenticated mutations passed the same-origin request guard above.
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > (url.pathname === "/api/forecast/import" ? 600000 : 16384)) {
        send(413, {});
        return;
      }
    }
    const body = text ? JSON.parse(text) : {};
    if (ctx.stopping || ctx.deploymentGate.blocked()) {
      const safeStop =
        url.pathname === "/api/control" &&
        (body.command === "stop" || body.command === "emergency");
      if (!safeStop) {
        send(409, { error: "DEPLOYMENT_MAINTENANCE" });
        return;
      }
    }
    if (url.pathname === "/api/forecast/import") {
      try {
        send(200, importForecast(ctx.db, ctx.pair, body, Date.now()));
      } catch (error) {
        if (error instanceof Error && error.message === "INVALID_FORECAST_MIGRATION")
          send(400, { error: error.message });
        else throw error;
      }
      return;
    }
    if (url.pathname === "/api/paper-check/arm") {
      if (
        req.method !== "POST" ||
        ctx.db.runtime().running ||
        ctx.pair !== "SUI_USDC"
      ) {
        send(409, { error: "PAPER_CHECK_ARM_REJECTED" });
        return;
      }
      try {
        ctx.paperCheck.arm(ctx.pair, body.expiresAt, body.issuedAt);
      } catch {
        send(409, { error: "PAPER_CHECK_ARM_REJECTED" });
        return;
      }
      send(200, ctx.paperCheck.status());
      return;
    }
    if (url.pathname === "/api/pairs") {
      const parsed = body.pair;
      if (!ctx.paperCheck.pairAllowed(String(parsed))) {
        send(409, { error: "PAPER_CHECK_PAIR_FORBIDDEN" });
        return;
      }
      if (parsed !== "SUI_USDC" && parsed !== "WAL_USDC") {
        send(400, { error: "INVALID_TRADING_PAIR" });
        return;
      }
      if (parsed === ctx.pair) {
        send(200, { selected: ctx.pair });
        return;
      }
      if (
        ctx.inFlightRequests > 1 ||
        ctx.db.runtime().running ||
        ctx.activeTick ||
        ctx.backtestBusy ||
        apiAccess
          .snapshot()
          .some((a) => a.active || (a.nextRetryAt ?? 0) > Date.now())
      ) {
        send(409, { error: "STOP_AND_WAIT_BEFORE_PAIR_SWITCH" });
        return;
      }
      const sourceBlocker = ctx.db.pairSwitchBlocker();
      if (sourceBlocker) {
        send(409, { error: sourceBlocker, pair: ctx.pair });
        return;
      }
      ctx.switching = true;
      try {
        // Fully prepare the replacement before closing the old context.
        const nextDb = new BotDatabase(ctx.pairPath(parsed));
        // Inspect before boot(), which intentionally interrupts old pending candidates.
        const targetBlocker = nextDb.pairSwitchBlocker();
        if (targetBlocker) {
          nextDb.close();
          ctx.switching = false;
          send(409, { error: targetBlocker, pair: parsed });
          return;
        }
        let next;
        const nextReset = new PredecessorReset(nextDb, apiAccess, ctx.bootId, parsed, !ctx.resetPairs.has(parsed));
        try {
          next = createEngine(ctx, nextDb, parsed);
          next.engine.monitor.boot();
        } catch (error) {
          next?.sui.close();
          nextDb.close();
          ctx.engine.activateApiHooks();
          throw error;
        }
        ctx.scheduler.stop();
        await ctx.chartHistory.close();
        if (ctx.stopping || ctx.deploymentGate.blocked()) {
          next.sui.close();
          nextDb.close();
          ctx.engine.activateApiHooks();
          ctx.switching = false;
          send(409, { error: "DEPLOYMENT_MAINTENANCE" });
          return;
        }
        validationHeartbeat(ctx, true);
        ctx.validation?.closed();
        ctx.db.set("api_cooldowns", apiAccess.snapshot());
        ctx.sui.close();
        ctx.db.close();
        ctx.pair = parsed;
        ctx.db = nextDb;
        ctx.engine = next.engine;
        ctx.sui = next.sui;
        ctx.db.set(
          "runtime_build",
          runtimeBuild(
            process.env,
            readFileSync(
              new URL("../../../pnpm-lock.yaml", import.meta.url),
              "utf8",
            ),
          ),
        );
        apiAccess.clearPairState();
        apiAccess.restoreCooldowns(ctx.db.get("api_cooldowns") ?? []);
        nextReset.activate(ctx.engine.monitor);
        ctx.predecessorReset = nextReset;
        ctx.resetPairs.add(parsed);
        ctx.validation = ctx.validationEnabled ? new ValidationRecorder(ctx.db) : undefined;
        ctx.engine.validation = ctx.validation;
        ctx.validation?.boot();
        ctx.selectionDb.set("selected_pair", ctx.pair);
        ctx.chartHistory = createChartHistory(ctx);
        ctx.dashboard = new DashboardService(ctx.engine, ctx.db);
        ctx.scheduler = createScheduler(ctx);
        ctx.scheduler.start();
        ctx.switching = false;
        send(200, { selected: ctx.pair, running: false });
      } catch {
        // A partially replaced context must never serve data or accept orders.
        try {
          ctx.db.set("runtime", { ...ctx.db.runtime(), running: false });
        } catch {}
        ctx.scheduler.stop();
        send(503, { error: "PAIR_SWITCH_FAILED_RESTART_REQUIRED" });
        setTimeout(() => process.exit(1), 100).unref();
      }
      return;
    }
    if (ctx.validation && url.pathname === "/api/validation/start") {
      try {
        const report = ctx.validation.begin();
        validationHeartbeat(ctx, true);
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
      if (ctx.backtestBusy) {
        send(409, { error: "BACKTEST_BUSY" });
        return;
      }
      const parsed = comparisonOptionsSchema.safeParse(body);
      if (!parsed.success) {
        send(400, { error: "INVALID_BACKTEST_OPTIONS" });
        return;
      }
      ctx.backtestBusy = true;
      try {
        const result = await savedComparison(ctx.db, parsed.data);
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
        ctx.backtestBusy = false;
      }
      return;
    }
    if (url.pathname === "/api/settings") {
      const settings = settingsSchema.parse(body);
      ctx.db.updateSettings(settings);
      send(200, settings);
      return;
    }
    if (url.pathname === "/api/control") {
      const command = body.command;
      const r = ctx.db.runtime();
      if (command === "emergency")
        ctx.db.set("runtime", { ...r, running: false, emergency: true });
      else if (command === "clear-emergency") {
        // The owner's dedicated release for an owner-latched emergency
        // (PR #105 left this path unbuilt: the scoped reset refuses
        // emergencies by contract, and nothing else could clear one).
        // Only the emergency flag is touched — a latched error keeps
        // its own release path — and an explicit confirm string is
        // required so a stray or replayed command cannot release it.
        if (r.running) { send(409, { error: "EMERGENCY_CLEAR_RUNNING" }); return; }
        if (!r.emergency) { send(409, { error: "EMERGENCY_NOT_ACTIVE" }); return; }
        if (body.confirm !== "CLEAR-EMERGENCY") {
          send(400, { error: "EMERGENCY_CLEAR_CONFIRM_REQUIRED" });
          return;
        }
        ctx.db.set("runtime", { ...r, emergency: false });
      }
      else if (command === "stop") ctx.db.set("runtime", { ...r, running: false });
      else if (command === "reset") {
        const pending = ctx.predecessorReset.needsWarmupAfterReset();
        const refusal = ctx.predecessorReset.clear(body.expectedReset);
        if (refusal) { send(409, { error: refusal }); return; }
        if (pending && ctx.scheduler) {
          // Only stopped predecessor warmup was held; do not wait another long interval.
          ctx.scheduler.stop();
          ctx.scheduler = createScheduler(ctx);
          ctx.scheduler.start();
        }
        send(200, ctx.db.runtime());
        return;
      } else if (command === "start") {
        if (!ctx.paperCheck.ordersAllowed(ctx.pair)) {
          send(409, { error: "PAPER_CHECK_LEASE_REQUIRED" });
          return;
        }
        const timing = ctx.engine.monitor.timing();
        if (timing.fetchElapsedMs != null && timing.fetchElapsedMs > 45000) {
          send(409, { error: "MARKET_FETCH_IN_PROGRESS" });
          return;
        }
        if (ctx.engine.monitor.safety().connectivity !== "HEALTHY") {
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
        if (!ctx.sui.status.healthy || Date.now() - ctx.sui.status.checkedAt > 180000) {
          send(409, { error: "HEALTH_CHECK_REQUIRED" });
          return;
        }
        if (!ctx.engine.monitor.ledger().ok) {
          send(409, { error: "ACCOUNTING_CHECK_REQUIRED" });
          return;
        }
        ctx.db.set("runtime", { ...r, running: true });
      } else {
        send(400, { error: "UNKNOWN_COMMAND" });
        return;
      }
      ctx.engine.monitor.transition(
        command === "start"
          ? "MANUAL_START"
          : command === "stop"
            ? "MANUAL_STOP"
            : command === "emergency"
              ? "EMERGENCY_STOP"
              : command === "clear-emergency"
                ? "EMERGENCY_CLEARED"
                : "MANUAL_RESET",
      );
      send(200, ctx.db.runtime());
      return;
    }
    send(404, { error: "NOT_FOUND" });
  } catch {
    send(400, { error: "REQUEST_FAILED" });
  }
};
}
