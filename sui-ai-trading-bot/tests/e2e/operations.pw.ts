import { test, expect, type Page } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
import type { CandidateAudit } from "../../packages/shared/src/operations.ts";

async function open(
  page: Page,
  status: "STOPPED" | "RUNNING" | "DATA_DELAYED" | "ABNORMAL_STOP",
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
    reasons: ["PROJECTED_NET_INSUFFICIENT"],
  };
  db.putCandidate(candidate);
  const state = engine.snapshot(),
    operations = engine.monitor.snapshot();
  db.close();
  let fail = false;
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
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
  await page.getByRole("button", { name: "運用検証", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "運用検証", exact: true, level: 2 }),
  ).toBeVisible();
  return {
    writes,
    fail: () => {
      fail = true;
    },
  };
}
for (const [status, label] of [
  ["STOPPED", "停止中"],
  ["RUNNING", "正常稼働中"],
  ["DATA_DELAYED", "データ遅延"],
  ["ABNORMAL_STOP", "異常停止"],
] as const) {
  test(`displays ${status}, zero-trade reports, sanitized candidate reasons and atomic tolerances`, async ({
    page,
  }, info) => {
    const api = await open(page, status);
    await expect(page.locator(".operation-state")).toContainText(label);
    await expect(
      page.getByRole("article", { name: "24時間レポート" }),
    ).toContainText("0件");
    await expect(
      page.getByRole("article", { name: "7日間レポート" }),
    ).toContainText("0件");
    await expect(
      page.getByText(
        "取引ゼロ件も正常な検証結果です。売買がなくても条件を自動で緩めません。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByText(/許容誤差：SUI 0.000000001/)).toBeVisible();
    await page.locator(".operation-candidate summary").click();
    await expect(page.locator(".operation-candidate")).toContainText(
      "未評価（前段の条件未通過または処理中）",
    );
    await expect(page.locator(".operation-candidate")).toContainText(
      "想定純利益が往復費用または最低基準に届かないため見送り",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    for (const summary of await page
      .locator(".operation-validation summary:visible")
      .all())
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(api.writes).toEqual([]);
    if (status === "STOPPED")
      await page.screenshot({
        path: info.outputPath("operation-validation.png"),
        fullPage: true,
      });
  });
}
test("does not show stale information as healthy after a monitoring API error", async ({
  page,
}) => {
  await page.clock.install();
  const api = await open(page, "RUNNING");
  api.fail();
  await page.clock.runFor(11000);
  await expect(page.getByRole("alert")).toContainText(
    "運用検証データを取得できません",
  );
  await expect(page.locator(".operation-state")).toContainText("接続状態不明");
  await expect(page.locator(".operation-state.healthy")).toHaveCount(0);
  expect(api.writes).toEqual([]);
});
