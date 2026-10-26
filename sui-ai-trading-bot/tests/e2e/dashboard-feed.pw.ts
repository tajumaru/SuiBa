import { test, expect } from "@playwright/test";
import { validationFixture } from "../deepbook-ui-fixture.ts";
import { chartFixture } from "../chart-fixture.ts";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { DashboardService } from "../../apps/worker/src/dashboard-feed.ts";
import type { BotEngine } from "../../apps/worker/src/engine.ts";
test("modern feed keeps status prompt, caches charts and recovers failed channels", async ({
  page,
}, info) => {
  const { state, operations } = validationFixture("unstarted");
  const db = new BotDatabase(":memory:");
  for (const tf of [300, 900, 3600] as const)
    db.saveCandles(
      chartFixture().map((c, i) => ({
        ...c,
        timeframe: tf,
        timestamp: c.timestamp - i * 300 + i * tf,
      })),
    );
  const service = new DashboardService(
    { snapshot: () => state } as unknown as BotEngine,
    db,
  );
  let summaryCalls = 0,
    frameCalls = 0,
    recordCalls = 0,
    stateCalls = 0,
    operationsCalls = 0,
    fail = false,
    corrupt = false;
  await page.clock.install();
  await page.route("**/api/**", async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/dashboard/summary") {
      summaryCalls++;
      return route.fulfill({
        status: fail ? 503 : 200,
        json: fail ? { error: "HTTP_503" } : service.summary(),
      });
    }
    if (u.pathname === "/api/dashboard/candles") {
      frameCalls++;
      const r = service.candles(
        Number(u.searchParams.get("timeframe")) as 300,
        u.searchParams.get("version"),
      );
      if (corrupt) r.version = "corrupt";
      return route.fulfill({ json: r });
    }
    if (u.pathname === "/api/dashboard/records") {
      recordCalls++;
      return route.fulfill({ json: service.records() });
    }
    if (u.pathname === "/api/operations") {
      operationsCalls++;
      return route.fulfill({ json: operations });
    }
    if (u.pathname === "/api/state") {
      stateCalls++;
      return route.fulfill({ json: state });
    }
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  const readyStart = performance.now();
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "エージェント実況", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "通信とPAPER注文の状態", exact: true }),
  ).toBeVisible();
  await expect.poll(() => frameCalls).toBe(1);
  await expect.poll(() => recordCalls).toBe(1);
  console.info(
    JSON.stringify({
      viewport: info.project.name,
      readyMs: performance.now() - readyStart,
    }),
  );
  await page.clock.runFor(11000);
  await expect.poll(() => summaryCalls).toBeGreaterThan(1);
  expect(frameCalls).toBe(1);
  expect(recordCalls).toBe(1);
  // Every /api/state call so far belongs to an operations poll
  // pair (operations + state are always fetched together): the
  // dashboard client itself never fell back to the legacy endpoint.
  await expect.poll(() => stateCalls - operationsCalls).toBe(0);
  expect(operationsCalls).toBeGreaterThan(0);
  corrupt = true;
  const last = db.candles(300).at(-1)!;
  db.saveCandles([{ ...last, timestamp: last.timestamp + 300 }]);
  await page.clock.runFor(11000);
  await expect(page.getByRole("alert")).toContainText("古い可能性");
  corrupt = false;
  await page.clock.runFor(11000);
  await expect(
    page.getByText("表示済みのデータは古い可能性があります。", {
      exact: false,
    }),
  ).toHaveCount(0);
  fail = true;
  await page.clock.runFor(11000);
  await expect(page.getByRole("alert")).toContainText("HTTP_503");
  fail = false;
  await page.clock.runFor(11000);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: /SUI\/USDC 現在価格/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("modern-feed.png"),
    fullPage: true,
  });
  db.close();
});
