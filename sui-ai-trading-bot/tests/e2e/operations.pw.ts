import { test, expect, type Page } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
import type { CandidateAudit } from "../../packages/shared/src/operations.ts";
import type { OperationsSnapshot } from "../../apps/dashboard/src/operationsTypes.ts";

async function open(
  page: Page,
  status: "STOPPED" | "RUNNING" | "DATA_DELAYED" | "ABNORMAL_STOP",
  limited = false,
  networkFailure = false,
) {
  const db = new BotDatabase(":memory:");
  db.set("runtime", {
    ...db.runtime(),
    running: status === "RUNNING" || status === "DATA_DELAYED",
    error: status === "ABNORMAL_STOP" ? "PAPER_RECONCILIATION_FAILED" : null,
  });
  const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw new Error("unused");
      },
      validateQuote: async () => false,
    },
    { health: async () => health, status: health },
  );
  if (status === "RUNNING") {
    engine.monitor.market(Date.now());
    engine.monitor.healthy();
  }
  const stamp = Date.now();
  const candidate: CandidateAudit = {
    id: "candidate",
    orderId: "order",
    timestamp: stamp,
    createdAt: stamp,
    side: "BUY",
    requestedInputAtomic: "2000000",
    quantityAtomic: "997000000",
    quotePriceUsdc: "2.006",
    quoteExpiresAt: stamp + 15000,
    acquisitionCostUsdc: "2.036",
    expectedSaleUsdc: "2.04",
    saleModel: "PROJECTED_TARGET",
    dexFeeUsdc: null,
    gasUsdc: "0.03",
    additionalFeeUsdc: "0.006",
    buyGasUsdc: "0.03",
    netProfitUsdc: "-0.026",
    minProfitUsdc: "0.05",
    minProfitPct: "0.015",
    profitGuard: {
      evaluated: true,
      allowed: false,
      reason: "PROJECTED_NET_INSUFFICIENT",
    },
    risk: { status: "NOT_EVALUATED", reasons: [] },
    finalAction: "WAIT",
    reasons: ["PROFIT_GUARD_PROJECTED_NET_INSUFFICIENT"],
  };
  db.putCandidate(candidate);
  const state = engine.snapshot(),
    operations = engine.monitor.snapshot();
  if (status === "RUNNING") {
    operations.safety.ordersAllowed = true;
    operations.safety.connectivity = "HEALTHY";
    operations.timing.dataStatus = "FRESH";
    operations.timing.transportRecent = true;
    operations.lastHeartbeatAt = Date.now();
    operations.lastMarketClosedAt = Date.now() - 300_000;
    operations.timing.lastTransportSuccessAt = Date.now();
  }
  if (limited) {
    operations.stopReason = "UPSTREAM_HTTP_429";
    operations.apis[1] = {
      ...operations.apis[1],
      requests: 7,
      rateLimits: 2,
      retries: 1,
      backoff: true,
      nextRetryAt: Date.now() + 30000,
      failed: true,
    };
  }
  if (networkFailure) {
    operations.stopReason = "UPSTREAM_DNS_FAILED";
    operations.apis[1].failed = true;
    operations.apis[1].lastFailure = {
      api: "GeckoTerminal",
      host: "api.geckoterminal.com",
      url: "https://api.geckoterminal.com/api/v2/networks/sui-network/pools/0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443/ohlcv/minute?aggregate=5&limit=1000&currency=token&token=quote&include_empty_intervals=false",
      method: "GET",
      operation: "OHLCV_5M",
      code: "UPSTREAM_DNS_FAILED",
      causeCode: "EAI_AGAIN",
      phase: "DNS",
      status: null,
      elapsedMs: 42,
      occurredAt: Date.now(),
    };
  }
  db.close();
  let fail = false;
  let authenticated = false;
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/auth/session") {
      if (route.request().method() === "POST") authenticated = true;
      if (route.request().method() === "DELETE") authenticated = false;
      return route.fulfill({
        status: authenticated ? 200 : 401,
        json: { authenticated },
      });
    }
    if (new URL(route.request().url()).pathname === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    if (route.request().method() !== "GET")
      writes.push(new URL(route.request().url()).pathname);
    if (route.request().url().endsWith("/api/state")) {
      await route.fulfill({ json: state });
      return;
    }
    if (route.request().url().endsWith("/api/operations")) {
      if (fail) await route.abort();
      else await route.fulfill({ json: operations });
      return;
    }
    throw new Error("Unexpected test API");
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only-not-a-real-credential");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Workerの状態", exact: true }),
  ).toBeVisible();
  return {
    writes,
    state,
    fail: () => {
      fail = true;
    },
  };
}
test("routine data updates finish on the next one-second status poll then return to normal polling", async ({
  page,
}) => {
  await page.clock.install();
  const { state } = await open(page, "RUNNING");
  state.safety.marketUpdating = true;
  state.safety.ordersAllowed = false;
  let calls = 0;
  await page.route("**/api/state", (route) => {
    calls++;
    return route.fulfill({ json: state });
  });
  await page.reload();
  await expect(page.locator(".operation-bar-state")).toContainText(
    "データ更新中",
  );
  const before = calls;
  state.safety.marketUpdating = false;
  state.safety.ordersAllowed = true;
  await page.clock.runFor(1500);
  await expect(page.locator(".operation-bar-state")).toContainText("正常稼働");
  expect(calls).toBeGreaterThan(before);
  const after = calls;
  await page.clock.runFor(5000);
  expect(calls).toBe(after);
});

test("thin-book advice opens and focuses the trade amount setting without saving", async ({
  page,
}) => {
  const { state, writes } = await open(page, "STOPPED");
  state.runtime.error = "THIN_ORDERBOOK";
  await page.reload();
  await page.getByRole("button", { name: "戦略", exact: true }).click();
  await expect(
    page.getByText("注文額を見直してください", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "取引額の設定を開く", exact: true })
    .click();
  const amount = page.locator("#setting-maxOrder");
  await expect(amount).toBeVisible();
  await expect(amount).toBeFocused();
  await expect(amount).toHaveValue(String(state.settings.maxOrder));
  expect(writes).toEqual([]);
});

test("history fits the phone width including reasons and expanded technical details", async ({
  page,
}, info) => {
  const { state } = await open(page, "STOPPED");
  state.orders.push({
    timestamp: Date.now(),
    side: "BUY",
    status: "REJECTED",
    reasons: ["PROFIT_GUARD_PROJECTED_NET_INSUFFICIENT"],
    id: "long-order-id-".repeat(20),
  });
  state.trades.push({
    orderId: "fill",
    side: "BUY",
    timestamp: Date.now(),
    quantity: 123.456789,
    price: 2.123456,
    fee: 0.03,
    pnl: null,
    slippage: 0,
    priceImpact: 0,
    allocatedCostUsdc: "12345678901234567890.123456789",
  });
  await page.reload();
  await page.getByRole("button", { name: "取引履歴", exact: true }).click();
  const orders = page.getByRole("table", { name: "注文履歴", exact: true });
  await expect(orders).toContainText("拒否");
  await expect(orders).toContainText(
    "手数料を払うと、十分に儲からないので見送りました",
  );
  await orders.getByText("注文の技術情報", { exact: true }).click();
  await expect(orders.locator("pre")).toBeVisible();
  if (page.viewportSize()!.width <= 600) {
    const dimensions = await page
      .locator(".history-scroll")
      .evaluateAll((elements) =>
        elements.map((e) => ({
          permitsScroll: e.classList.contains("order-history-scroll"),
          width: e.clientWidth,
          content: e.scrollWidth,
          left: e.getBoundingClientRect().left,
          right: e.getBoundingClientRect().right,
        })),
      );
    for (const box of dimensions) {
      if (!box.permitsScroll)
        expect(box.content).toBeLessThanOrEqual(box.width + 1);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    await expect(orders.locator("tbody td[data-label='理由']")).toHaveCSS(
      "display",
      "table-cell",
    );
  } else {
    await expect(orders).toHaveCSS("display", "table");
  }
  await orders.getByText("注文の技術情報", { exact: true }).click();
  await orders.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("history.png"),
    fullPage: true,
  });
});

test("narration survives polling, reconnects and stops without duplicates or unsafe poses", async ({
  page,
}, info) => {
  await page.clock.install();
  const api = await open(page, "RUNNING");
  await page.getByRole("button", { name: "実況", exact: true }).click();
  const feed = page.getByRole("region", {
    name: "エージェント実況",
    exact: true,
  });
  // The character's pose hook (pose-* class) lives on the header
  // avatar now; the in-feed stage was removed.
  const avatar = page.locator(".agent-avatar");
  const operations = (await page.evaluate(async () =>
    (await fetch("/api/operations")).json(),
  )) as OperationsSnapshot;
  let fail = false;
  await page.route("**/api/operations", (route) =>
    fail ? route.abort() : route.fulfill({ json: operations }),
  );
  const stamp = await page.evaluate(() => Date.now());
  operations.candidates = [
    {
      ...operations.candidates[0],
      id: "pending-to-filled",
      finalAction: "PENDING",
      timestamp: stamp,
    },
  ];
  await page.clock.runFor(10_000);
  operations.candidates[0].finalAction = "BUY";
  operations.candidates[0].timestamp = stamp + 20_000;
  operations.lastHeartbeatAt = stamp + 20_000;
  await page.clock.runFor(10_000);
  await expect(feed.locator(".agent-feed-entry.trade")).toHaveCount(1);
  await expect(avatar).toHaveClass(/pose-pointSmile/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(avatar.locator("img")).toHaveCSS("animation-name", "none");
  fail = true;
  await page.clock.runFor(10_000);
  await expect(avatar).toHaveClass(/pose-normal/);
  fail = false;
  operations.lastHeartbeatAt = stamp + 40_000;
  await page.clock.runFor(10_000);
  await expect(feed.locator(".agent-feed-entry.trade")).toHaveCount(1);
  operations.status = "STOPPED";
  operations.safety.botState = "MANUAL_STOP";
  await page.clock.runFor(10_000);
  await expect(avatar).toHaveClass(/pose-sleep/);
  operations.status = "ABNORMAL_STOP";
  operations.stopReason = "PAPER_RECONCILIATION_FAILED";
  operations.safety.botState = "ABNORMAL_STOP";
  await page.clock.runFor(10_000);
  await expect(avatar).toHaveClass(/pose-sleep/);
  await expect(feed.locator(".agent-feed-entry.stop").last()).toContainText(
    "止まったよ",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(api.writes).toEqual([]);
  await feed.screenshot({ path: info.outputPath("narration-stopped.png") });
});
