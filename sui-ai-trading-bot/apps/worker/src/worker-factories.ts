import { refreshBoss } from "./boss.ts";
import { OpenAIShadowAdapter } from "./shadow-openai.ts";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BotEngine } from "./engine.ts";
import { ChartHistoryClient } from "./chart-history-client.ts";
import { MarketScheduler } from "./scheduler.ts";
import { exportValidationReport } from "./validation-report.ts";
import { DeepBookMarketData } from "../../../packages/market-data/src/deepbook.ts";
import { MarketSelection } from "../../../packages/market-data/src/selection.ts";
import { GeckoMarketData } from "../../../packages/market-data/src/index.ts";
import { CetusRouter } from "../../../packages/dex-router/src/index.ts";
import { WalPaperRouter } from "../../../packages/dex-router/src/pair-router.ts";
import { ReadOnlySuiClient } from "../../../packages/sui-client/src/index.ts";
import { apiAccess } from "../../../packages/shared/src/api.ts";
import { paperRecoveryLimits } from "../../../packages/shared/src/paper-recovery.ts";
import type { BotDatabase } from "../../../packages/database/src/index.ts";
import {
  DBUSDC,
  USDC,
  type TradingPair,
} from "../../../packages/shared/src/index.ts";
import type { WorkerContext } from "./worker-context.ts";
import { readForecast } from "./forecast.ts";
import { SHADOW_PROMPT_VERSION } from "./shadow.ts";
import { NarrationGenerator } from "./narration-generator.ts";
import type { createRealTradeCapRuntime } from "./real/runtime.ts";

/**
 * The worker's factories, extracted from the boot script: the
 * engine assembly for a pair, the chart-history client and the
 * market scheduler (both rebuilt around a pair switch), and the
 * validation heartbeat. Each takes the shared WorkerContext
 * and reads the live state through it, so a pair switch that
 * reassigns the context's fields is seen by every factory.
 */
export function createEngine(
  ctx: WorkerContext,
  database: BotDatabase,
  selected: TradingPair,
  realRuntime?: ReturnType<typeof createRealTradeCapRuntime>,
) {
  if (process.env.MODE === "REAL_TRADECAP" && selected !== "SUI_USDC")
    throw Error("REAL_PAIR_FORBIDDEN");
  const client = new ReadOnlySuiClient(ctx.suiGrpcEndpoints.primary, {
    network: ctx.suiGrpcEndpoints.network,
    quoteCoin: ctx.suiGrpcEndpoints.network === "testnet" ? DBUSDC : USDC,
    onObservation: (event) =>
      database.append("sui_observations", randomUUID(), event, event.at),
    fallbackUrls: ctx.suiGrpcEndpoints.fallbacks,
  });
  const deep = new DeepBookMarketData(
    () => database.settings(),
    undefined,
    ctx.reconstruction === "verified",
    selected,
  );
  const router = new CetusRouter();
  try {
    return {
      sui: client,
      engine: new BotEngine(
        database,
        new MarketSelection(
          selected === "WAL_USDC"
            ? "deepbook"
            : (ctx.marketMode as "geckoterminal" | "deepbook" | "auto"),
          new GeckoMarketData(process.env.MARKET_POOL || undefined),
          deep,
        ),
        selected === "WAL_USDC" ? new WalPaperRouter(router, deep) : router,
        client,
        selected,
        () =>
          ctx.stopping ||
          ctx.deploymentGate.blocked() ||
          ctx.paperCheck.expired(),
        () => ctx.chainSampler.current(),
        () => ctx.bookSamplers[selected].current(),
        () => ctx.btcSampler.current(),
        () => ctx.bookSamplers[selected].currentLevels(),
        () => (selected === "SUI_USDC" ? ctx.longTermSampler.current() : null),
        () => ctx.paperCheck.ordersAllowed(selected),
        new OpenAIShadowAdapter(), // OFF is still enforced by ShadowRecorder.
        ctx.selectionDb, // Worker-wide JST budget survives pair switches.
        process.env.MODE === "REAL_TRADECAP"
          ? (realRuntime?.executionAdapter ??
              (() => {
                throw Error("REAL_RUNTIME_REQUIRED");
              })())
          : undefined,
        () => ctx.fxRateSampler.current(),
        {
          network: ctx.suiGrpcEndpoints.network,
          realBalances: realRuntime?.realBalances,
          realReconciliation: realRuntime?.realReconciliation,
          realExecution: realRuntime?.realExecution,
        },
        ctx.perfTrace,
      ),
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

export function validationHeartbeat(ctx: WorkerContext, final = false) {
  if (!ctx.validation) return;
  ctx.validation.sample(ctx.engine.marketStatus());
  const now = Date.now();
  if (
    process.env.VALIDATION_REPORT_DIR &&
    (final || now - ctx.lastExportAt >= 60000)
  ) {
    exportValidationReport(
      ctx.pair === "SUI_USDC"
        ? process.env.VALIDATION_REPORT_DIR
        : resolve(process.env.VALIDATION_REPORT_DIR, ctx.pair),
      ctx.validation.report(now, true),
    );
    ctx.lastExportAt = now;
  }
}

export function generateNarrationSafely(ctx: WorkerContext) {
  try {
    return new NarrationGenerator(ctx.db, ctx.pair, ctx.engine).generate();
  } catch (error) {
    // Narration is deliberately outside the trading/safety failure path. Its
    // cursor remains uncommitted, so the next generation point replays it.
    ctx.engine.monitor.event("ERROR", "NARRATION_GENERATION_FAILED");
    console.warn(
      JSON.stringify({
        event: "NARRATION_GENERATION_FAILED",
        reason: error instanceof Error ? error.message : "UNKNOWN_FAILURE",
      }),
    );
    return 0;
  }
}

export const createChartHistory = (ctx: WorkerContext) =>
  new ChartHistoryClient(
    ctx.pairPath(ctx.pair) + ".chart-history.sqlite",
    () => {
      const timing = ctx.engine.monitor.timing();
      return (
        !ctx.stopping &&
        !apiAccess.blocked() &&
        !apiAccess
          .snapshot()
          .some((a) => a.api === "DeepBook Indexer" && a.active) &&
        !timing.fetching &&
        (timing.nextFetchAt == null || timing.nextFetchAt - Date.now() > 12000)
      );
    },
    ctx.pair,
  );

function refreshPartySafely(ctx: WorkerContext) {
  try {
    const forecast = readForecast(ctx.db, ctx.pair);
    // The stored lifetime count uses the same eligibility as scoredRecords.
    // Old saves can have a scored window without a lifetime count.
    ctx.db.refreshParty(
      Math.max(forecast.scoredTotal ?? 0, forecast.score?.scoredRecords ?? 0),
      SHADOW_PROMPT_VERSION,
    );
  } catch {
    console.warn(JSON.stringify({ event: "RPG_PARTY_REFRESH_FAILED" }));
  }
}

export const createScheduler = (ctx: WorkerContext) => {
  refreshPartySafely(ctx);
  return new MarketScheduler(
    async () => {
      // Do not turn a restored predecessor cooldown into a new boot-cycle failure.
      // Orders remain stopped; only an explicitly scoped reset releases warmup.
      if (ctx.predecessorReset.awaitingReset()) return;
      ctx.chartHistory.cancel();
      const finishCycle = ctx.perfTrace?.start("cycle");
      try {
        ctx.activeTick = ctx.engine.tick();
        await ctx.activeTick;
      } finally {
        ctx.activeTick = undefined;
        finishCycle?.();
      }
      refreshPartySafely(ctx);
      try {
        refreshBoss(ctx.db, ctx.pair);
      } catch {
        console.warn(JSON.stringify({ event: "BOSS_REFRESH_FAILED" }));
      }
      generateNarrationSafely(ctx);
      const maintenance = setImmediate(() => {
        try {
          ctx.db.maintainRetentionChunk();
          ctx.db.maintainNarrationRetentionChunk(ctx.pair);
        } catch {
          console.warn(
            JSON.stringify({
              event: "DATABASE_RETENTION_FAILED",
              databaseHealth: ctx.db.health(),
            }),
          );
        }
      });
      maintenance.unref();
    },
    () => ({
      // Recovery uses the normal acquisition/validation/Sui/ledger diagnostic;
      // only its cadence changes while trading is safely paused.
      intervalMs:
        ctx.engine.monitor.safety().resumePending &&
        !ctx.db.runtime().error &&
        !ctx.db.runtime().emergency
          ? paperRecoveryLimits.probeIntervalMs
          : ctx.db.settings().intervalMs,
      deepbook:
        ctx.pair === "WAL_USDC" ||
        ctx.marketMode === "deepbook" ||
        (ctx.marketMode === "auto" &&
          ctx.engine.marketStatus()?.source !== "GeckoTerminal"),
      latestClosedAt: ctx.engine.monitor.state().lastMarketClosedAt,
      healthy: ctx.engine.marketStatus()?.healthy ?? false,
      blocked: apiAccess.blocked(),
    }),
    (plan) =>
      ctx.engine.monitor.scheduled(plan?.at ?? null, plan?.reason ?? null),
    () => {
      console.error(
        JSON.stringify({
          event: "PAPER_WORKER_UNAVAILABLE",
          databaseHealth: ctx.db.health(),
        }),
      );
      process.exit(1);
    },
  );
};
