import { readBoss, readBossHistory } from "./boss.ts";
import {
  partyLevel,
  type PartyMember,
} from "../../../packages/shared/src/party.ts";
import { readForecast } from "./forecast.ts";
import {
  dayKey,
  type BookLevels,
  type BtcInfo,
  type ChainInfo,
  type DailyCandle,
  type Indicators,
  type ForceCloseRequest,
  type TradingPair,
} from "../../../packages/shared/src/index.ts";
import { marketWeather } from "./market-weather.ts";
import {
  positionOf,
  type ProfitReport,
} from "../../../packages/profit-guard/src/index.ts";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import type { MarketDataProvider } from "../../../packages/market-data/src/provider.ts";
import type { ReadOnlySuiClient } from "../../../packages/sui-client/src/index.ts";
import { equity, metrics } from "../../../packages/portfolio/src/index.ts";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import type { OperationMonitor } from "./operations.ts";
import {
  attributeEquityHistory,
  type EquityAttribution,
  type ValuationPoint,
} from "./equity-attribution.ts";
import type { RealBalances } from "./real/display-balances.ts";
import { shadowTodaySummary } from "./shadow-summary.ts";

/**
 * Downsample the recorded equity snapshots for the dashboard's
 * asset curve: the last point of each hour over the newest 30
 * days. The snapshots themselves are appended every analysis
 * cycle whether or not the dashboard is open; the wire gets at
 * most ~720 points, the full history stays in the database.
 */
export function downsampleEquityCurve(
  points: readonly {
    timestamp: number;
    equity: number;
    attribution?: EquityAttribution;
  }[],
  now: number,
): { t: number; equity: number; attribution?: EquityAttribution }[] {
  const from = now - 30 * 24 * 3600 * 1000;
  const byHour = new Map<
    number,
    { t: number; equity: number; attribution?: EquityAttribution }
  >();
  for (const p of points) {
    if (!Number.isFinite(p.equity) || p.timestamp < from) continue;
    byHour.set(Math.floor(p.timestamp / 3600000), {
      t: p.timestamp,
      equity: p.equity,
      ...(p.attribution ? { attribution: p.attribution } : {}),
    });
  }
  return [...byHour.values()].sort((a, b) => a.t - b.t);
}

/**
 * Everything buildSnapshot reads from the engine, gathered as
 * one explicit surface: the database, the monitor, the market
 * provider and the display-only sources the constructor was
 * given. BotEngine assembles it in snapshot(); nothing here
 * mutates the engine.
 */
export interface SnapshotSources {
  mode: "PAPER" | "REAL";
  forceClose?: ForceCloseRequest | null;
  network: "testnet" | "mainnet";
  realBalances?: () => RealBalances | undefined;
  realReconciliation?: () => { nonTerminalSubmissions: number };
  realExecution?: () => { orderType: "MARKET" | "IOC_LIMIT" };
  pair: TradingPair;
  db: BotDatabase;
  cache?: SnapshotCache;
  monitor: OperationMonitor;
  market: MarketDataProvider;
  sui: Pick<ReadOnlySuiClient, "health" | "status">;
  chainInfo: () => ChainInfo | null;
  btcInfo: () => BtcInfo | null;
  bookImbalance: () => number | null;
  bookLevels: () => BookLevels | null;
  longTermDaily: () => DailyCandle[] | null;
}

type SnapshotCacheEntry = {
  key: string;
  value: ReturnType<typeof buildDatabaseSnapshot>;
};

export type SnapshotCache = Partial<Record<"light" | "full", SnapshotCacheEntry>>;

export function createSnapshotCache(): SnapshotCache {
  return {};
}

function buildDatabaseSnapshot(
  src: SnapshotSources,
  light: boolean,
  now: number,
) {
  const p = src.db.portfolio(),
    price = src.db.get<number>("price") ?? null,
    trades = src.db.history<Fill>("paper_trades", 10000),
    snapshots = src.db
      .history<ValuationPoint>("portfolio_snapshots", 10000)
      .reverse(),
    values = snapshots.map((x) => x.equity),
    indicators = src.db.get<Indicators>("indicators") ?? null;
  const today = dayKey(now);
  return {
    network: src.network,
    pair: src.pair,
    boss: readBoss(src.db, src.pair),
    bossHistory: readBossHistory(src.db, src.pair),
    party: Object.fromEntries(
      src.db
        .partyRecords()
        .map(({ member, count }) => [
          member,
          { ...partyLevel(member, count), count },
        ]),
    ) as Partial<
      Record<PartyMember, ReturnType<typeof partyLevel> & { count?: number }>
    >,
    sageWork: (() => {
      const counts = src.db.sageWorkCounts(now);
      return {
        decisions30d: counts.decisions,
        verification: {
          title: "下降・横ばいでは買わない",
          target: 30,
          down: counts.downSignals,
          range: counts.rangeSignals,
        },
      };
    })(),
    forecast: readForecast(src.db, src.pair),
    forecastError: src.db.get("forecast_error") ?? null,
    marketQuality: src.db.get("market_quality") ?? null,
    mode: src.mode,
    runtime: src.db.runtime(),
    latestManualFill:
      trades.find((trade) => trade.sellPurpose === "MANUAL") ?? null,
    latestTradeAt: trades[0]?.timestamp ?? null,
    price,
    portfolio: p,
    equity: price === null ? null : equity(p, price),
    pnl: price === null ? null : equity(p, price) - p.initialEquity,
    dailyPnl: price === null ? null : equity(p, price) - p.dayStartEquity,
    unrealized: price === null ? null : p.sui * price - p.costBasis,
    equityCurve: downsampleEquityCurve(
      attributeEquityHistory(
        snapshots,
        src.db.range<Fill>("paper_trades", 0, Number.MAX_SAFE_INTEGER),
        p,
      ),
      now,
    ),
    todayTrades: trades.filter((x) => dayKey(x.timestamp) === today).length,
    metrics: metrics(
      values,
      trades.flatMap((x) => (x.pnl === null ? [] : [x.pnl])),
    ),
    indicators,
    // Display-only market weather: judged here from the
    // stored 5-minute candles and the engine's indicators,
    // because the light snapshot drops the candle series
    // the dashboard would need to judge it itself.
    weather: marketWeather(src.db.candles(300), indicators),
    settings: src.db.settings(),
    profitGuard: src.db.get<ProfitReport>("profitGuard") ?? null,
    acquisitionCostUsdc: positionOf(p).costUsdc,
    acquisitionFees: trades.find((t) => t.side === "BUY")?.acquisition ?? null,
    trades: light ? [] : trades.slice(0, 200),
    orders: light ? [] : src.db.orderHistory(),
    riskEvents: light ? [] : src.db.history("risk_events"),
    candles: light ? [] : src.db.candles(),
    candlesByTimeframe: {
      300: light ? [] : src.db.candles(300),
      900: light ? [] : src.db.candles(900),
      3600: light ? [] : src.db.candles(3600),
    },
    strategies: [
      { id: "rule-based", available: true },
      { id: "deepseek", available: false },
    ],
  };
}

function readDatabaseSnapshot(
  src: SnapshotSources,
  light: boolean,
  now: number,
) {
  const cache = src.cache;
  if (!cache) return buildDatabaseSnapshot(src, light, now);

  const variant = light ? "light" : "full";
  // Refresh rolling windows even when the database is idle.
  const key = `${src.db.displayVersion()}:${src.pair}:${Math.floor(now / 3600000)}`;
  const cached = cache[variant];
  if (cached?.key === key) return cached.value;

  const value = buildDatabaseSnapshot(src, light, now);
  cache[variant] = { key, value };
  return value;
}

/**
 * Assemble the dashboard snapshot from stored data and live display sources.
 * The light variant omits the heavy histories for the polling feed.
 */
export function buildSnapshot(
  src: SnapshotSources,
  options: { light?: boolean } = {},
) {
  const decision = src.monitor.displayDecision();
  const realBalances = src.mode === "REAL" ? src.realBalances?.() : undefined;
  const realReconciliation =
    src.mode === "REAL" ? src.realReconciliation?.() : undefined;
  const realExecution = src.mode === "REAL" ? src.realExecution?.() : undefined;
  return {
    ...readDatabaseSnapshot(src, options.light ?? false, Date.now()),
    ...(realBalances ? { realBalances } : {}),
    ...(realReconciliation ? { realReconciliation } : {}),
    ...(realExecution ? { realExecution } : {}),
    chain: src.chainInfo(),
    btc: src.btcInfo(),
    // Display-only book imbalance for the model outlook:
    // the live validated book when the trading path has one
    // (DeepBook routes), else the independent sampler.
    bookImbalance:
      src.market.bookImbalance?.(Date.now()) ?? src.bookImbalance(),
    // Display-only top-of-book levels for the narration's
    // wall watch: the live validated book when the trading
    // path has one, else the independent sampler.
    bookLevels: src.market.bookLevels?.(Date.now()) ?? src.bookLevels(),
    // The sampler can refresh its daily series without a database write.
    longTermDaily: src.longTermDaily(),
    marketData: src.market.status?.() ?? null,
    // Pending requests can expire without a database write.
    forceClose: src.forceClose ?? null,
    safety: src.monitor.safetySnapshot(),
    connection: src.sui.status,
    shadowToday:
      process.env.SUIBA_SHADOW_ENABLED === "true"
        ? shadowTodaySummary(src.db)
        : null,
    decision,
  };
}
