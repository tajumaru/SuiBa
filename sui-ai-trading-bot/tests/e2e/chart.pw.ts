import { test, expect, type Page } from "@playwright/test";
import { validationFixture } from "../deepbook-ui-fixture.ts";
import { chartFixture } from "../chart-fixture.ts";
import { chartTime } from "../../apps/dashboard/src/chartPresentation.ts";
async function open(page: Page, empty = false, provisional = false) {
  const { state, operations } = validationFixture("unstarted"),
    candles = empty ? [] : chartFixture();
  const last = candles.at(-1);
  if (last) {
    last.provenance = {
      origin: "ONE_MINUTE_AGGREGATE",
      upstream: "DeepBook Indexer",
      pair: "SUI_USDC",
      fetchedAt: (last.timestamp + 300) * 1000,
      timeframe: 300,
      evidence: ["five closed one-minute bars"],
    };
  }
  state.candles = candles;
  state.candlesByTimeframe[300] = candles;
  const now = last
    ? (last.timestamp + (provisional ? 100 : 301)) * 1000
    : Date.UTC(2026, 9, 22);
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now + 1000));
  const calls: string[] = [];
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    calls.push(
      `${route.request().method()} ${new URL(route.request().url()).pathname}`,
    );
    return route.fulfill({
      json: route.request().url().endsWith("/api/state") ? state : operations,
    });
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only-no-real-token");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  // Keep chart time deterministic while allowing authenticated navigation.
  await expect(page.getByRole("status")).toHaveText("おはようございます！");
  await page.clock.runFor(1000);
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  const chart = page.getByLabel("SUI/USDC価格表示", { exact: true });
  await expect(chart).toBeVisible();
  return { chart, calls, candles };
}
test("chart periods show real JST endpoints, preserve indicators and add no requests", async ({
  page,
}, info) => {
  const { chart, calls, candles } = await open(page);
  const baseline = [...calls];
  const end = candles.at(-1)!.timestamp + 300;
  for (const [name, hours] of [
    ["1時間", 1],
    ["6時間", 6],
    ["24時間", 24],
    ["7日", 168],
  ] as const) {
    await chart.getByRole("button", { name, exact: true }).click();
    await expect(
      chart.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const range = chart.getByLabel("実際の表示期間");
    await expect(range).toContainText(chartTime(end));
    await expect(range).toContainText(
      chartTime(Math.max(candles[0].timestamp, end - hours * 3600)),
    );
  }
  await expect(chart).toContainText("データ不足");
  await expect(chart.getByLabel("選択したローソク足")).toContainText(
    "再構築（確定1分足から集約）",
  );
  await expect(chart.getByLabel("選択したローソク足")).toContainText(
    "DeepBook:SUI_USDC:USDC",
  );
  await expect(chart).toContainText("確定済み");
  await chart.getByRole("button", { name: "6時間", exact: true }).click();
  const emaBefore = await chart
    .locator('polyline[aria-label="EMA20"]')
    .getAttribute("points");
  await chart.getByRole("button", { name: "1時間", exact: true }).click();
  await chart.getByRole("button", { name: "6時間", exact: true }).click();
  expect(
    await chart.locator('polyline[aria-label="EMA20"]').getAttribute("points"),
  ).toBe(emaBefore);
  expect(calls).toEqual(baseline);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await chart.screenshot({ path: info.outputPath("price-chart.png") });
});
test("chart zoom pan hover tap slider keyboard and latest update visible period", async ({
  page,
}) => {
  const { chart, calls } = await open(page);
  const baseline = [...calls];
  const range = chart.getByLabel("実際の表示期間"),
    initial = await range.textContent();
  await chart.getByRole("button", { name: "過去へ", exact: true }).click();
  await expect(range).not.toHaveText(initial!);
  await chart
    .getByRole("button", { name: "最新データへ戻る", exact: true })
    .click();
  await expect(range).toHaveText(initial!);
  await chart.getByRole("button", { name: "拡大", exact: true }).click();
  await expect(range).not.toHaveText(initial!);
  await chart.getByRole("button", { name: "6時間", exact: true }).click();
  const svg = chart.getByRole("img", { name: "価格チャート", exact: true });
  await svg.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(range).not.toHaveText(initial!);
  await page.keyboard.press("Home");
  await expect(range).toHaveText(initial!);
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(range).not.toHaveText(initial!);
  await chart
    .getByRole("button", { name: "最新データへ戻る", exact: true })
    .click();
  await expect(range).toHaveText(initial!);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect(range).not.toHaveText(initial!);
  const slider = chart.getByRole("slider", { name: "ローソク足を選択" });
  await slider.focus();
  await page.keyboard.press("Home");
  const detail = chart.getByLabel("選択したローソク足");
  await expect(detail).toContainText("再構築情報なし");
  await page.keyboard.press("End");
  await expect(detail).toContainText("再構築（確定1分足から集約）");
  if (infoMobile(page)) {
    await svg.tap({ position: { x: 30, y: 100 } });
    await expect(detail).toContainText("始値（Open）");
  } else {
    await svg.click({ position: { x: 30, y: 100 } });
    await expect(detail).toContainText("終値（Close）");
  }
  expect(calls).toEqual(baseline);
});
function infoMobile(page: Page) {
  return page.viewportSize()!.width < 600;
}
test("empty chart never fabricates a range", async ({ page }) => {
  const { chart } = await open(page, true);
  await expect(chart).toContainText("期間を取得できません");
  await expect(
    chart.getByRole("button", { name: "7日", exact: true }),
  ).toBeVisible();
  await chart.getByRole("button", { name: "7日", exact: true }).click();
  await expect(chart).toContainText("期間を取得できません");
});
test("unconfirmed candle has a distinct state and end time", async ({
  page,
}) => {
  const { chart, candles } = await open(page, false, true);
  await expect(chart.getByLabel("選択したローソク足")).toContainText("未確定");
  await expect(chart.getByLabel("実際の表示期間")).toContainText(
    chartTime(candles.at(-1)!.timestamp + 300),
  );
  await expect(
    chart.getByRole("img", { name: "価格チャート", exact: true }),
  ).toContainText("○");
});
