import {
  dayKey,
  type BookLevels,
  type BtcInfo,
  type ChainInfo,
  type DailyCandle,
  type Indicators,
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

/**
 * Downsample the recorded equity snapshots for the dashboard's
 * asset curve: the last point of each hour over the newest 30
 * days. The snapshots themselves are appended every analysis
 * cycle whether or not the dashboard is open; the wire gets at
 * most ~720 points, the full history stays in the database.
 */
export function downsampleEquityCurve(
  points: readonly { timestamp: number; equity: number }[],
  now: number,
): { t: number; equity: number }[] {
  const from = now - 30 * 24 * 3600 * 1000;
  const byHour = new Map<number, { t: number; equity: number }>();
  for (const p of points) {
    if (!Number.isFinite(p.equity) || p.timestamp < from) continue;
    byHour.set(Math.floor(p.timestamp / 3600000), {
      t: p.timestamp,
      equity: p.equity,
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
  pair: TradingPair;
  db: BotDatabase;
  monitor: OperationMonitor;
  market: MarketDataProvider;
  sui: Pick<ReadOnlySuiClient, "health" | "status">;
  chainInfo: () => ChainInfo | null;
  btcInfo: () => BtcInfo | null;
  bookImbalance: () => number | null;
  bookLevels: () => BookLevels | null;
  longTermDaily: () => DailyCandle[] | null;
}

/**
 * The dashboard snapshot, extracted from BotEngine: a pure
 * read over the database and the display sources (the light
 * variant omits the heavy histories for the polling feed).
 */
export function buildSnapshot(
  src: SnapshotSources,
  options: { light?: boolean } = {},
) {
    const decision = src.monitor.displayDecision();
    const p = src.db.portfolio(),
      price = src.db.get<number>("price") ?? null,
      trades = src.db.history<Fill>("paper_trades", 10000),
      snapshots = src.db
        .history<{ timestamp: number; equity: number }>(
          "portfolio_snapshots",
          10000,
        )
        .reverse(),
      values = snapshots.map((x) => x.equity),
      indicators = src.db.get<Indicators>("indicators") ?? null;
    return {
      pair: src.pair,
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
      bookLevels:
        src.market.bookLevels?.(Date.now()) ?? src.bookLevels(),
      longTermDaily: src.longTermDaily(),
      marketData: src.market.status?.() ?? null,
      marketQuality: src.db.get("market_quality") ?? null,
      mode: "PAPER",
      runtime: src.db.runtime(),
      safety: src.monitor.safetySnapshot(),
      connection: src.sui.status,
      price,
      portfolio: p,
      equity: price === null ? null : equity(p, price),
      pnl: price === null ? null : equity(p, price) - p.initialEquity,
      dailyPnl: price === null ? null : equity(p, price) - p.dayStartEquity,
      unrealized: price === null ? null : p.sui * price - p.costBasis,
      equityCurve: downsampleEquityCurve(snapshots, Date.now()),
      todayTrades: trades.filter(
        (x) => dayKey(x.timestamp) === dayKey(Date.now()),
      ).length,
      metrics: metrics(
        values,
        trades.flatMap((x) => (x.pnl === null ? [] : [x.pnl])),
      ),
      decision,
      indicators,
      // Display-only market weather: judged here from the
      // stored 5-minute candles and the engine's indicators,
      // because the light snapshot drops the candle series
      // the dashboard would need to judge it itself.
      weather: marketWeather(src.db.candles(300), indicators),
      settings: src.db.settings(),
      profitGuard: src.db.get<ProfitReport>("profitGuard") ?? null,
      acquisitionCostUsdc: positionOf(p).costUsdc,
      acquisitionFees:
        trades.find((t) => t.side === "BUY")?.acquisition ?? null,
      trades: options.light ? [] : trades.slice(0, 200),
      orders: options.light ? [] : src.db.history("paper_orders"),
      riskEvents: options.light ? [] : src.db.history("risk_events"),
      candles: options.light ? [] : src.db.candles(),
      candlesByTimeframe: {
        300: options.light ? [] : src.db.candles(300),
        900: options.light ? [] : src.db.candles(900),
        3600: options.light ? [] : src.db.candles(3600),
      },
      strategies: [
        { id: "rule-based", available: true },
        { id: "deepseek", available: false },
      ],
    };
  }
