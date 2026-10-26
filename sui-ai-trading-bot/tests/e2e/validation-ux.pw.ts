import { test, expect } from "@playwright/test";
import { validationFixture, scenarios } from "../deepbook-ui-fixture.ts";
for (const scenario of scenarios)
  test(`validation UX ${scenario}`, async ({ page }, info) => {
    const { operations, state } = validationFixture(scenario);
    const writes: string[] = [];
    await page.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/dashboard/summary")
        return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
      if (route.request().method() !== "GET")
        writes.push(route.request().url());
      return route.fulfill({
        json: route.request().url().endsWith("/api/state") ? state : operations,
      });
    });
    await page.goto("/");
    await page.getByLabel("管理トークン").fill("test-only-no-real-token");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await page.getByRole("button", { name: "運用検証", exact: true }).click();
    await page.locator("#operation-diagnostics > summary").click();
    const panel = page.getByRole("region", { name: "DeepBook 24時間検証" });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByLabel("重要な4つの指標").getByRole("article"),
    ).toHaveCount(4);
    for (const d of await panel.locator(":scope > details").all())
      await expect(d).not.toHaveAttribute("open", "");
    if (scenario === "unstarted") {
      await expect(panel).toContainText("24時間検証：未開始");
      await expect(
        panel.getByRole("article", { name: "PAPER実稼働時間", exact: true }),
      ).toContainText("未計測");
    } else {
      await expect(panel.getByRole("progressbar")).toHaveAttribute(
        "value",
        ["failed", "passed"].includes(scenario) ? "1" : String(1 / 24),
      );
      await expect(panel).toContainText("日本時間");
    }
    if (scenario === "stopped") {
      await expect(panel).toContainText("PAPER Bot：停止中");
      await expect(
        page.getByRole("region", { name: "運用検証コントロール" }),
      ).toContainText("計測だけが進行しています");
    }
    if (scenario === "running")
      await expect(panel).toContainText("PAPER Bot：稼働中");
    if (scenario === "api-error") {
      await expect(
        panel.getByRole("alert").filter({ hasText: "API取得失敗" }),
      ).toBeVisible();
      await panel.getByRole("link", { name: "通信の詳細" }).click();
      await expect(panel.locator("#validation-api-details")).toHaveAttribute(
        "open",
        "",
      );
      await expect(panel).toContainText("HTTP 429");
    }
    if (scenario === "missing") {
      await expect(
        panel.getByRole("alert").filter({ hasText: "未解決の5分足欠損" }),
      ).toBeVisible();
      await panel.getByRole("link", { name: "品質の詳細を確認" }).click();
      await expect(
        panel.getByRole("article", { name: "未解決の5分足欠損", exact: true }),
      ).toContainText("2本");
    }
    if (scenario === "safety-stop") {
      await expect(
        page.getByRole("region", { name: "運用検証コントロール" }),
      ).toContainText("停止理由");
      await expect(panel).toContainText("PAPER Bot：異常停止");
    }
    if (scenario === "partial")
      await expect(panel).toContainText("計測中（検証途中）");
    if (scenario === "failed") {
      await expect(panel).toContainText("完了・条件未達");
      await expect(
        panel.getByRole("heading", { name: "合格条件の未達・未確認項目" }),
      ).toBeVisible();
      await expect(panel).toContainText("十分なPAPER実稼働時間");
    }
    if (scenario === "passed") {
      await expect(panel).toContainText("完了・合格");
      await expect(
        panel.getByRole("heading", { name: "確認できた合格条件" }),
      ).toBeVisible();
    }
    if (scenario === "restarted") {
      const value = await panel.getByRole("progressbar").getAttribute("value");
      await page.reload();
      await page.getByLabel("管理トークン").fill("test-only-no-real-token");
      await page.getByRole("button", { name: "接続", exact: true }).click();
      await page.getByRole("button", { name: "運用検証", exact: true }).click();
      await page.locator("#operation-diagnostics > summary").click();
      await expect(panel.getByRole("progressbar")).toHaveAttribute(
        "value",
        value!,
      );
    }
    if (scenario !== "unstarted") {
      if (
        (await panel
          .locator("#validation-diagnostics")
          .getAttribute("open")) === null
      )
        await panel.locator("#validation-diagnostics > summary").click();
      const summary = panel.locator("#validation-quality-details > summary");
      await summary.focus();
      if (
        (await panel
          .locator("#validation-quality-details")
          .getAttribute("open")) === null
      )
        await page.keyboard.press("Enter");
      await expect(
        panel.locator("#validation-quality-details"),
      ).toHaveAttribute("open", "");
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(writes).toEqual([]);
    if (["stopped", "running", "safety-stop", "passed"].includes(scenario)) {
      await panel.screenshot({
        path: info.outputPath(`validation-${scenario}.png`),
      });
    }
  });

for (const kind of ["running-before-begin", "stale-display"] as const)
  test(`validation UX ${kind}`, async ({ page }) => {
    const { operations, state } = validationFixture(
      kind === "running-before-begin" ? "unstarted" : "running",
    );
    if (kind === "running-before-begin") {
      operations.status = "RUNNING";
      state.runtime.running = true;
    }
    let fail = false;
    const writes: string[] = [];
    await page.clock.install();
    await page.route("**/api/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/api/dashboard/summary")
        return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
      if (route.request().method() !== "GET")
        writes.push(route.request().url());
      if (fail && route.request().url().endsWith("/api/operations"))
        return route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } });
      return route.fulfill({
        json: route.request().url().endsWith("/api/state") ? state : operations,
      });
    });
    await page.goto("/");
    await page.getByLabel("管理トークン").fill("test-only-no-real-token");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await page.getByRole("button", { name: "運用検証", exact: true }).click();
    await page.locator("#operation-diagnostics > summary").click();
    const panel = page.getByRole("region", { name: "DeepBook 24時間検証" });
    await expect(panel).toBeVisible();
    const control = page.getByRole("region", { name: "運用検証コントロール" });
    if (kind === "running-before-begin") {
      await expect(
        control.getByRole("button", { name: "24時間計測を開始", exact: true }),
      ).toHaveCount(0);
      await expect(
        control.getByRole("button", { name: "PAPER Botを開始", exact: true }),
      ).toHaveCount(0);
      await expect(
        control.getByRole("button", { name: "PAPER Botを停止", exact: true }),
      ).toBeEnabled();
      await expect(control.getByRole("status")).toContainText(
        "PAPER Bot稼働中",
      );
      await expect(panel).toContainText("24時間検証：未開始");
    } else {
      fail = true;
      await page.clock.fastForward(11000);
      await expect(panel).toContainText("PAPER Bot：状態不明");
      await expect(panel).toContainText("DeepBook接続：状態不明");
      await expect(control.getByRole("status")).toContainText("状態不明");
      await expect(
        control.getByRole("button", { name: "PAPER Botを開始", exact: true }),
      ).toHaveCount(0);
      await expect(
        control.getByRole("button", { name: "PAPER Botを停止", exact: true }),
      ).toBeEnabled();
    }
    expect(writes).toEqual([]);
  });
