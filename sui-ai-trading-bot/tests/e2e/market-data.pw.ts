import { test, expect } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
test("shows Japanese source fallback and stale state without starting PAPER", async ({
  page,
}) => {
  const db = new BotDatabase(":memory:");
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw Error("NO_TRADES");
      },
      validateQuote: async () => false,
    },
    {
      health: async () => ({
        healthy: true,
        checkedAt: Date.now(),
        failures: 0,
      }),
      status: { healthy: true, checkedAt: Date.now(), failures: 0 },
    },
  );
  const state = {
    ...engine.snapshot(),
    marketData: {
      quality: {
        300: {
          upstream: "DeepBook Indexer",
          pair: "SUI_USDC",
          fetchedAt: Date.now(),
          timeframe: 300,
          missing: 43,
          reconstructed: 43,
          unresolved: 0,
          latestClosedAt: Math.floor(Date.now() / 300000) * 300000,
          origins: {
            ORIGINAL: 999,
            NO_INDEXED_TRADES: 43,
            ONE_MINUTE_AGGREGATE: 0,
          },
        },
      },
      configured: "auto",
      source: "GeckoTerminal",
      fallback: true,
      lastSuccessAt: Date.now() - 600000,
      latencyMs: 350,
      reason: "CANDLE_GAP",
      healthy: true,
      bookAt: null,
      bid: null,
      ask: null,
      spread: null,
    },
  };
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    await route.fulfill({
      json: route.request().url().endsWith("/api/state")
        ? state
        : engine.monitor.snapshot(),
    });
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only-no-real-credential");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  const region = page.getByRole("region", { name: "市場データ接続" });
  await expect(region).toContainText("現在の取得元：GeckoTerminal");
  await expect(region).toContainText("取得停止・データ遅延");
  await expect(region).toContainText("代替取得中");
  await expect(region).toContainText("自動再開しません");
  await expect(region).toContainText("350 ms");
  await expect(region).toContainText("再構築 43本");
  await expect(region).toContainText("未解決 0本");
  expect(writes).toEqual([]);
  const dims = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dims.scroll).toBeLessThanOrEqual(dims.width);
  db.close();
});
