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
import type { BotDatabase } from "../../../packages/database/src/index.ts";
import type { TradingPair } from "../../../packages/shared/src/index.ts";
import type { WorkerContext } from "./worker-context.ts";

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
) {
  const client = new ReadOnlySuiClient(ctx.suiGrpcEndpoints.primary, {
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
        () => ctx.stopping || ctx.deploymentGate.blocked() || ctx.paperCheck.expired(),
        () => ctx.chainSampler.current(),
        () => ctx.bookSamplers[selected].current(),
        () => ctx.btcSampler.current(),
        () => ctx.bookSamplers[selected].currentLevels(),
        () => (selected === "SUI_USDC" ? ctx.longTermSampler.current() : null),
        () => ctx.paperCheck.ordersAllowed(selected),
        new OpenAIShadowAdapter(), // OFF is still enforced by ShadowRecorder.
        ctx.selectionDb, // Worker-wide JST budget survives pair switches.
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

export const createScheduler = (ctx: WorkerContext) =>
  new MarketScheduler(
    async () => {
      // Do not turn a restored predecessor cooldown into a new boot-cycle failure.
      // Orders remain stopped; only an explicitly scoped reset releases warmup.
      if (ctx.predecessorReset.awaitingReset()) return;
      ctx.chartHistory.cancel();
      ctx.activeTick = ctx.engine.tick();
      try {
        await ctx.activeTick;
      } finally {
        ctx.activeTick = undefined;
      }
    },
    () => ({
      intervalMs: ctx.db.settings().intervalMs,
      deepbook:
        ctx.pair === "WAL_USDC" ||
        ctx.marketMode === "deepbook" ||
        (ctx.marketMode === "auto" &&
          ctx.engine.marketStatus()?.source !== "GeckoTerminal"),
      latestClosedAt: ctx.engine.monitor.state().lastMarketClosedAt,
      healthy: ctx.engine.marketStatus()?.healthy ?? false,
      blocked: apiAccess.blocked(),
    }),
    (plan) => ctx.engine.monitor.scheduled(plan?.at ?? null, plan?.reason ?? null),
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
