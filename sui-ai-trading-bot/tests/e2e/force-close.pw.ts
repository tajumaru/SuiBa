import { expect, test, type Page } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";

function snapshot() {
  const db = new BotDatabase(":memory:");
  try {
    db.set("portfolio", { ...db.portfolio(), sui: 5, costBasis: 10 });
    db.set("runtime", { ...db.runtime(), running: true });
    db.set("price", 2.1);
    const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
    const engine = new BotEngine(
      db,
      { candles: async () => [] },
      {
        getQuote: async () => {
          throw Error("UNUSED");
        },
        validateQuote: async () => false,
      },
      { status: health, health: async () => health },
    );
    return { state: engine.snapshot(), operations: engine.monitor.snapshot() };
  } finally {
    db.close();
  }
}

async function openOverview(
  page: Page,
  { state, operations }: ReturnType<typeof snapshot>,
) {
  const commands: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    switch (new URL(route.request().url()).pathname) {
      case "/api/state":
        return route.fulfill({ json: state });
      case "/api/operations":
        return route.fulfill({ json: operations });
      case "/api/auth/session":
        return route.fulfill({ json: { authenticated: true } });
      case "/api/control":
        commands.push(route.request().postDataJSON());
        state.forceClose = { requestedAt: Date.now() };
        return route.fulfill({ json: state.forceClose });
      default:
        return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    }
  });
  await page.goto("/");
  await expect(page.getByRole("img", { name: /現在価格/ })).toBeVisible();
  await page.locator(".boot-screen").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "[いま]", exact: true }),
  ).toBeVisible();
  return commands;
}

test("confirms, sends one command, and shows the final MANUAL fill once", async ({
  page,
}) => {
  const fixture = snapshot();
  const { state } = fixture;
  const commands = await openOverview(page, fixture);
  const assets = page.getByRole("region", { name: "資産", exact: true });
  const command = assets.getByRole("button", { name: /とどめの一撃/ });
  await expect(command).toContainText("手数料控除前 +0.50 USDC 見込み");
  await command.click();
  await expect(assets.getByText(/保有分をすべて売りますか/)).toBeVisible();
  expect(commands).toEqual([]);
  await assets.getByRole("button", { name: "戻る" }).click();
  await command.click();
  await assets.getByRole("button", { name: /確定する/ }).click();
  await expect(assets.getByText("強制決済中")).toBeVisible();
  expect(commands).toEqual([{ command: "force-close" }]);

  state.portfolio.sui = 0;
  state.forceClose = null;
  state.latestTradeAt = Date.now();
  state.latestManualFill = {
    orderId: "manual-test",
    side: "SELL",
    sellPurpose: "MANUAL",
    timestamp: state.latestTradeAt,
    quantity: 5,
    price: 2.1,
    fee: 0.1,
    pnl: 0.4,
    slippage: 0,
    priceImpact: 0,
  };
  const result = assets.getByRole("status").filter({ hasText: "強制決済完了" });
  await expect(result).toContainText("+0.40 USDC", { timeout: 15_000 });
  await expect(result).toHaveCount(1);
  await expect(assets.getByRole("region", { name: "ポジション" })).toHaveCount(
    0,
  );
});

for (const stateName of [
  "REAL",
  "empty",
  "stopped",
  "emergency",
  "error",
] as const) {
  test(`hides force-close when ${stateName}`, async ({ page }) => {
    const fixture = snapshot();
    const { state } = fixture;
    if (stateName === "REAL") state.mode = "REAL";
    if (stateName === "empty") state.portfolio.sui = 0;
    if (stateName === "stopped") state.runtime.running = false;
    if (stateName === "emergency") state.runtime.emergency = true;
    if (stateName === "error") state.runtime.error = "TEST_ERROR";
    await openOverview(page, fixture);
    await expect(page.getByRole("region", { name: "ポジション" })).toHaveCount(
      0,
    );
  });
}
