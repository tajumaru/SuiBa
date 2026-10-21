import { test, expect } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
test("shows publication wait and independent fetch/analysis/schedule times without starting PAPER", async ({
  page,
}) => {
  const db = new BotDatabase(":memory:"),
    health = { healthy: true, checkedAt: Date.now(), failures: 0 },
    engine = new BotEngine(
      db,
      { candles: async () => [] },
      {
        getQuote: async () => {
          throw Error("NO_ORDER");
        },
        validateQuote: async () => false,
      },
      { health: async () => health, status: health },
    );
  const now = Math.floor(Date.now() / 300000) * 300000 + 20000;
  engine.monitor.market(now - 320000, now - 10000);
  engine.monitor.transportSuccess(now - 10000);
  engine.monitor.analysis(now - 5000);
  engine.monitor.scheduled(now + 20000);
  const operations = engine.monitor.snapshot(now),
    state = engine.snapshot(),
    writes: string[] = [];
  db.close();
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    return route.fulfill({
      json: route.request().url().endsWith("/api/state") ? state : operations,
    });
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only-no-real-token");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await page.getByRole("button", { name: "運用検証", exact: true }).click();
  const panel = page.getByLabel("市場データ取得タイミング");
  await expect(panel).toContainText("確定足の更新待ち");
  await expect(panel).toContainText("直近の成功あり");
  await expect(panel).toContainText("最終取得試行");
  await expect(panel).toContainText("最終分析成功");
  await expect(panel).toContainText("次回予定");
  expect(writes).toEqual([]);
  const dims = await page.evaluate(() => ({
    w: innerWidth,
    s: document.documentElement.scrollWidth,
  }));
  expect(dims.s).toBeLessThanOrEqual(dims.w);
});
