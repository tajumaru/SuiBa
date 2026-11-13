import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import {
  initialPortfolio,
  type Fill,
} from "../packages/paper-trading/src/index.ts";

/** Offline display fixture: no network client, worker loop, or persistent database. */
export function dashboardPreviewFixture({ equityRoundTrip = false } = {}) {
  const db = new BotDatabase(":memory:");
  const now = Date.now();
  if (equityRoundTrip) {
    const hour = 3600000;
    const trades: Fill[] = [
      {
        orderId: "preview-buy",
        side: "BUY",
        timestamp: now - 6 * hour,
        quantity: 1,
        price: 10,
        fee: 0.01,
        pnl: null,
        slippage: 0,
        priceImpact: 0,
      },
      {
        orderId: "preview-sell",
        side: "SELL",
        timestamp: now - 3 * hour,
        quantity: 1,
        price: 9.21,
        fee: 0.01,
        pnl: -0.81,
        slippage: 0,
        priceImpact: 0,
      },
    ];
    for (const trade of trades)
      db.append("paper_trades", trade.orderId, trade, trade.timestamp);
    db.set("portfolio", {
      ...initialPortfolio(now, 100),
      usdc: 99.19,
      realized: -0.81,
      fees: 0.02,
    });
    const points = [
      { timestamp: now - 8 * 24 * hour, equity: 100 },
      { timestamp: now - 23 * hour, equity: 100 },
      { timestamp: now - 5 * hour, equity: 99.99 },
      { timestamp: now - 2 * hour, equity: 99.19 },
      { timestamp: now, equity: 99.19 },
    ];
    for (const point of points)
      db.append(
        "portfolio_snapshots",
        `preview-${point.timestamp}`,
        point,
        point.timestamp,
      );
  }
  const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw Error("OFFLINE_PREVIEW");
      },
      validateQuote: async () => false,
    },
    { health: async () => health, status: health },
  );
  const state = engine.snapshot();
  const operations = engine.monitor.snapshot();
  operations.lastHeartbeatAt = now - 5000;
  operations.timing.lastAnalysisAt = now - 12000;
  operations.safety.lastStopReason = "MANUAL_STOP";
  operations.reports.find((r) => r.hours === 168)!.stopReasons = [
    { timestamp: now - 60000, reason: "MANUAL_STOP" },
  ];
  db.close();
  return { state, operations };
}
