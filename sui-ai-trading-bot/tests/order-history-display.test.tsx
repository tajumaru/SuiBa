import { it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { DashboardService } from "../apps/worker/src/dashboard-feed.ts";
import { DashboardClient } from "../apps/dashboard/src/dashboardClient.ts";
import { OrderHistory } from "../apps/dashboard/src/OrderHistory.tsx";
import { dateTime } from "../apps/dashboard/src/presentation.ts";

it("carries persisted SQL order times through both display APIs to the history props", async () => {
  const db = new BotDatabase(":memory:");
  try {
    const times = [1794435600000, 1794439200000];
    const raw = {
      side: "BUY",
      status: "FILLED",
      quote: { amountIn: "2.12345678", referencePrice: 1.234567 },
    };
    db.append("paper_orders", "buy", raw, times[0]);
    db.append(
      "paper_orders",
      "sell",
      { side: "SELL", status: "FILLED" },
      times[1],
    );
    const status = { healthy: true, checkedAt: times[1], failures: 0 };
    const engine = new BotEngine(
      db,
      { candles: async () => [] },
      {
        getQuote: async () => {
          throw Error("NO_TRADE");
        },
        validateQuote: async () => false,
      },
      { health: async () => status, status },
    );
    const service = new DashboardService(engine, db);
    const records = service.recordsData();
    expect(records.orders.map((o) => o.timestamp)).toEqual(
      [...times].reverse(),
    );
    expect(engine.snapshot().orders).toEqual(records.orders);
    const client = new DashboardClient();
    const result = await client.poll(
      async (path) => {
        if (path === "dashboard/summary") return service.summary();
        if (path.startsWith("dashboard/records")) return service.records();
        if (path.startsWith("dashboard/candles"))
          return service.candles(300, null);
        if (path.startsWith("dashboard/long-term")) return service.longTerm();
        throw Error(path);
      },
      null,
      true,
      () => {},
    );
    expect(result.channelError).toBeNull();
    expect(result.state.orders).toEqual(records.orders);
    // API payload is passed unchanged to OrderHistory by the dashboard client.
    const html = renderToStaticMarkup(
      <OrderHistory orders={result.state.orders} />,
    );
    for (const time of times) expect(html).toContain(dateTime(time));
    expect(html).toContain("2.1235 USDC");
    expect(html).toContain("1.2346");
    expect(html).toContain("注文の技術情報");
    expect(db.history("paper_orders")[1]).toEqual(raw);
  } finally {
    db.close();
  }
});
it("keeps an order with no supplied display time as 未取得", () => {
  expect(
    renderToStaticMarkup(
      <OrderHistory orders={[{ side: "SELL", status: "FILLED" }]} />,
    ),
  ).toContain("未取得");
});
