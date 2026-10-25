import { test, expect } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
import { compareBacktests } from "../../packages/backtest-engine/src/index.ts";
import { defaults, type Candle } from "../../packages/shared/src/index.ts";

test("Japanese screens preserve actions, ratios and epochs across all viewports", async ({
  page,
}, info) => {
  const stamp = Date.UTC(2026, 0, 1, 15);
  const db = new BotDatabase(":memory:");
  const decision = {
    action: "BUY",
    confidence: 0.7,
    reason: "EMA上昇・RSI回復・MACD改善",
    timestamp: new Date(stamp).toISOString(),
    stopLossPct: 0.02,
    takeProfitPct: 0.04,
  };
  db.set("decision", decision);
  db.set("runtime", { ...db.runtime(), error: "FUTURE_ERROR" });
  db.append(
    "paper_orders",
    "reject",
    {
      timestamp: stamp,
      side: "BUY",
      status: "REJECTED",
      reasons: ["MAX_ORDER"],
    },
    stamp,
  );
  db.append(
    "paper_trades",
    "trade",
    {
      orderId: "trade",
      timestamp: stamp,
      side: "SELL",
      quantity: 1,
      price: 1234.5678,
      fee: 0.03,
      pnl: 0.02,
    },
    stamp,
  );
  const health = { healthy: true, checkedAt: stamp, failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw new Error("UNUSED");
      },
      validateQuote: async () => false,
    },
    { health: async () => health, status: health },
  );
  const state = engine.snapshot();
  const operations = engine.monitor.snapshot();
  db.close();
  const start = stamp / 1000;
  const candles: Candle[] = Array.from({ length: 100 }, (_, i) => ({
    timestamp: start + i * 300,
    timeframe: 300,
    source: "SYNTHETIC_TEST",
    open: 2,
    close: 2,
    high: 2.01,
    low: 1.99,
    volume: 100000,
  }));
  const result = await compareBacktests(
    candles,
    {
      start: start + 65 * 300,
      end: start + 99 * 300,
      trainEnd: start + 64 * 300,
    },
    defaults,
    {
      strategyFactory: () => ({
        analyze: async () => ({ ...decision, action: "BUY" }),
      }),
    },
  );
  const posts: Record<string, number>[] = [];
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/operations") return route.fulfill({ json: operations });
    if (path === "/api/backtest") {
      if (route.request().method() === "POST") {
        posts.push(route.request().postDataJSON());
        return route.fulfill({ json: result });
      }
      return route.fulfill({
        json: {
          count: 100,
          first: start,
          last: candles.at(-1)!.timestamp,
          source: "SYNTHETIC_TEST",
          timeframe: 300,
          latest: result,
        },
      });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "実況", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).toContainText(
    "安全条件またはデータの整合性を確認できません",
  );
  await expect(page.locator("main")).toContainText("コード：FUTURE_ERROR");
  await expect(page.locator("main")).toContainText("次の操作：");
  const fits = async () =>
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  await fits();
  for (const tab of [
    "ダッシュボード",
    "戦略",
    "取引履歴",
    "運用検証",
    "バックテスト比較",
  ]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: tab, exact: true, level: 1 }),
    ).toBeVisible();
    await fits();
    if (tab === "戦略")
      await expect(page.locator("main")).toContainText("取引判定：買い");
    if (tab === "取引履歴") {
      await expect(page.locator("table").first()).toContainText("売り");
      await expect(page.locator("table").first()).toContainText(
        "2026/01/02 00:00:00（日本時間）",
      );
      await expect(page.locator("table").first()).toContainText("1,234.5678");
      await expect(page.locator("table").nth(1)).toContainText("買い");
      await expect(page.locator("table").nth(1)).toContainText("1回の取引上限");
    }
  }
  await expect(
    page.getByRole("heading", { name: "比較結果", exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel("価格ずれの上限（%）")).toHaveValue("0.3");
  const startField = page.getByLabel("未使用の検証期間 開始（日本時間）");
  const localValue = await startField.inputValue();
  await startField.fill(localValue); // exercise the Japan time -> epoch conversion
  await page
    .getByRole("button", { name: "同じ条件で利益保護の有効／無効を比較" })
    .click();
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0].start).toBe(result.options.start);
  expect(posts[0].slippage).toBe(0.003);
  await expect(page.locator("table").last()).toContainText("買い / 見送り");
  await expect(page.locator("table").last()).toContainText("想定純利益");
  await expect(page.locator("table").last()).toContainText(
    "コード：PROJECTED_NET_INSUFFICIENT",
  );
  await fits();
  await page.screenshot({
    path: info.outputPath("japanese-backtest.png"),
    fullPage: true,
  });
});

test("authentication errors show Japanese and retain the code", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 401, json: { error: "UNAUTHORIZED" } }),
  );
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "管理トークンを確認できません",
  );
  await expect(page.getByRole("alert")).toContainText("コード：UNAUTHORIZED");
});
