import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { validationFixture } from "../deepbook-ui-fixture.ts";
import { verifiedDisplayRepairs } from "../../packages/shared/src/chart-gap-audit.ts";
import { parseDeepBook } from "../../packages/market-data/src/deepbook.ts";
test("audited gaps expose exact times and verified reconstruction causes", async ({
  page,
}, info) => {
  const report = JSON.parse(
    readFileSync("docs/evidence/chart-gaps-48/report.json", "utf8"),
  );
  const evidence = JSON.parse(
    readFileSync("docs/evidence/chart-gaps-48/responses.json", "utf8"),
  );
  const candles = [
    ...parseDeepBook({ candles: evidence.five }, 300, evidence.completedAt).map(
      (c) => ({ ...c, timeframe: 300 as const }),
    ),
    ...verifiedDisplayRepairs,
  ].sort((a, b) => a.timestamp - b.timestamp);
  const { state, operations } = validationFixture("unstarted");
  state.candles = candles.slice(-1000);
  state.candlesByTimeframe[300] = state.candles;
  await page.clock.install({ time: new Date(report.to * 1000 + 1000) });
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/chart/history")
      return route.fulfill({
        json: {
          candles,
          from: report.from,
          to: report.to,
          timeframe: 300,
          source: "DeepBook Indexer",
          fetchedAt: evidence.completedAt,
          missing: 0,
          error: null,
          cacheHit: true,
          requests: 0,
          nextRetryAt: null,
        },
      });
    if (path === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    return route.fulfill({ json: path === "/api/state" ? state : operations });
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await page.getByRole("button", { name: "チャート", exact: true }).click();
  await page
    .getByRole("button", { name: "DeepBookの7日履歴を取得", exact: true })
    .click();
  const quality = page.getByLabel("表示履歴の品質");
  await expect(quality).toContainText("期待：2016本");
  await expect(quality).toContainText("取得済み：2016本");
  await expect(quality).toContainText("原因未確定：0本");
  await page
    .getByLabel("欠損・再構築の日時")
    .selectOption(String(verifiedDisplayRepairs[0].timestamp));
  await expect(quality).toContainText("NO_TRADES_VERIFIED");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await quality.screenshot({ path: info.outputPath("audited-gaps.png") });
});
