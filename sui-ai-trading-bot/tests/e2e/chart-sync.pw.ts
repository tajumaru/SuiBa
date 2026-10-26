import { test, expect } from "@playwright/test";
import { validationFixture } from "../deepbook-ui-fixture.ts";
import { chartFixture } from "../chart-fixture.ts";
test("2016 bars share periods gestures and selection without repeated history transfer", async ({
  page,
}, info) => {
  const { state, operations } = validationFixture("unstarted"),
    base = chartFixture();
  const candles = Array.from({ length: 2136 }, (_, i) => ({
    ...base[i % 1000],
    timestamp: base[0].timestamp + i * 300,
  }));
  state.candles = candles.slice(-1000);
  state.candlesByTimeframe[300] = state.candles;
  const to = candles.at(-1)!.timestamp + 300;
  await page.clock.install({ time: new Date(to * 1000 + 1000) });
  await page.clock.pauseAt(new Date(to * 1000 + 2000));
  let historyRequests = 0;
  const writes: string[] = [];
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    if (route.request().method() !== "GET") writes.push(path);
    if (path === "/api/chart/history") {
      historyRequests++;
      return route.fulfill({
        json: {
          candles,
          from: candles[0].timestamp,
          to,
          timeframe: 300,
          source: "DeepBook Indexer",
          fetchedAt: to * 1000,
          missing: 0,
          error: null,
          cacheHit: false,
          requests: 3,
          nextRetryAt: null,
        },
      });
    }
    return route.fulfill({ json: path === "/api/state" ? state : operations });
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only-no-real-token");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  // The frozen chart clock must also advance the login success animation.
  await expect(page.getByRole("status")).toHaveText("おはようございます！");
  await page.clock.runFor(1000);
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  const chart = page.getByLabel("SUI/USDC価格表示", { exact: true });
  await expect(
    chart.getByRole("group", { name: "表示期間の選択" }),
  ).toHaveCount(1);
  await chart
    .getByRole("button", { name: "DeepBookの7日履歴を取得", exact: true })
    .click();
  await expect(chart).toContainText("2136本取得");
  await expect(chart).toContainText("2016本");
  await expect(chart.getByLabel("RSI連動チャート")).toBeVisible();
  await expect(chart.getByLabel("MACD連動チャート")).toBeVisible();
  async function synced() {
    const p = (await chart.getByLabel("実際の表示期間").textContent())!.replace(
      "表示期間：",
      "",
    );
    for (const kind of ["RSI", "MACD"])
      await expect(chart.getByLabel(`${kind}表示期間`)).toHaveText(
        `表示期間：${p}`,
      );
  }
  await synced();
  const initial = await chart.getByLabel("実際の表示期間").textContent();
  const t = performance.now();
  await chart.getByRole("button", { name: "拡大", exact: true }).click();
  await synced();
  const zoomMs = performance.now() - t;
  await expect(chart.getByLabel("実際の表示期間")).not.toHaveText(initial!);
  await chart.getByRole("button", { name: "過去へ", exact: true }).click();
  await synced();
  await chart
    .getByRole("button", { name: "最新データへ戻る", exact: true })
    .click();
  await synced();
  const rsi = chart.getByRole("img", { name: "RSIチャート", exact: true });
  await rsi.focus();
  await page.keyboard.press("ArrowLeft");
  await synced();
  await page.keyboard.press("Home");
  await synced();
  const slider = chart.getByRole("slider", { name: "ローソク足を選択" });
  await slider.focus();
  await page.keyboard.press("Home");
  const selected = (await chart
    .getByLabel("RSI連動チャート")
    .getByText(/^選択日時/)
    .textContent())!;
  await expect(
    chart.getByLabel("MACD連動チャート").getByText(/^選択日時/),
  ).toHaveText(selected);
  await chart.getByRole("button", { name: "7日", exact: true }).click();
  await synced();
  expect(historyRequests).toBe(1);
  await page.clock.fastForward(21000);
  expect(historyRequests).toBe(1);
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const elements = await chart.locator("svg *").count();
  console.info(
    JSON.stringify({
      viewport: info.project.name,
      bars: 2016,
      zoomMs,
      svgElements: elements,
    }),
  );
  expect(elements).toBeLessThan(9000);
  await chart.screenshot({ path: info.outputPath("linked-charts.png") });
});
