import { test, expect } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
import type { TradingPair } from "../../packages/shared/src/index.ts";
test("selects WAL while stopped, reloads isolated state, and shows WAL labels", async ({
  page,
}, info) => {
  const databases = [new BotDatabase(":memory:"), new BotDatabase(":memory:")];
  const engine = (i: number, pair: TradingPair) =>
    new BotEngine(
      databases[i],
      { candles: async () => [] },
      {
        getQuote: async () => {
          throw Error("NO_TRADE");
        },
        validateQuote: async () => false,
      },
      {
        health: async () => ({ healthy: false, checkedAt: 0, failures: 0 }),
        status: { healthy: false, checkedAt: 0, failures: 0 },
      },
      pair,
    );
  const engines = {
    SUI_USDC: engine(0, "SUI_USDC"),
    WAL_USDC: engine(1, "WAL_USDC"),
  };
  let selected: TradingPair = "SUI_USDC";
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({ json: { authenticated: true } });
    if (path === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    if (path === "/api/pairs" && route.request().method() === "POST") {
      selected = route.request().postDataJSON().pair;
      writes.push(selected);
      return route.fulfill({ json: { selected, running: false } });
    }
    return route.fulfill({
      json:
        path === "/api/state"
          ? engines[selected].snapshot()
          : engines[selected].monitor.snapshot(),
    });
  });
  await page.goto("/");
  const selector = page.getByRole("combobox", { name: "取引ペア" });
  await expect(selector).toHaveValue("SUI_USDC");
  await selector.selectOption("WAL_USDC");
  await expect(selector).toHaveValue("WAL_USDC");
  await expect(page.locator(".header-meta")).toContainText("WAL / USDC");
  await expect(page.locator(".price-ticker")).toContainText("WAL/USDC");
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  await expect(page.getByText("仮想WAL", { exact: true })).toBeVisible();
  expect(writes).toEqual(["WAL_USDC"]);
  const selectBox = await selector.boundingBox();
  const avatarBox = await page.locator(".agent-avatar").boundingBox();
  expect(selectBox).not.toBeNull();
  expect(avatarBox).not.toBeNull();
  expect(selectBox!.y + selectBox!.height).toBeLessThanOrEqual(avatarBox!.y);
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(width.scroll).toBeLessThanOrEqual(width.viewport);
  await page.screenshot({
    path: info.outputPath("wal-pair.png"),
    fullPage: true,
  });
  databases.forEach((db) => db.close());
});
