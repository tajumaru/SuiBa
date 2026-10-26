import { test, expect } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
import { initialPaperSafety } from "../../packages/shared/src/paper-recovery.ts";

for (const phase of [
  "DEGRADED",
  "RECOVERING",
  "HEALTHY",
  "MANUAL_STOP",
  "EMERGENCY_STOP",
  "ABNORMAL_STOP",
] as const) {
  test(`PAPER ${phase} exposes an accurate order gate without sending controls`, async ({
    page,
  }, info) => {
    const db = new BotDatabase(":memory:");
    const now = Date.now(),
      health = { healthy: true, checkedAt: now, failures: 0 };
    const engine = new BotEngine(
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
    const paused = phase === "DEGRADED" || phase === "RECOVERING";
    db.set("runtime", {
      ...db.runtime(),
      running: phase === "HEALTHY",
      emergency: phase === "EMERGENCY_STOP",
      error: phase === "ABNORMAL_STOP" ? "MARKET_DATA_STALLED" : null,
    });
    db.set("paper_safety", {
      ...initialPaperSafety(),
      connectivity: paused ? phase : "HEALTHY",
      resumePending: paused,
      healthyCycles: phase === "RECOVERING" ? 1 : 0,
      recoveredAt: phase === "HEALTHY" ? now : null,
    });
    engine.monitor.market(now, now);
    engine.monitor.transportSuccess(now);
    const state = engine.snapshot(),
      operations = engine.monitor.snapshot();
    db.close();
    const writes: string[] = [];
    await page.route("**/api/**", (route) => {
      if (new URL(route.request().url()).pathname === "/api/dashboard/summary")
        return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
      if (route.request().method() !== "GET")
        writes.push(route.request().url());
      return route.fulfill({
        json: route.request().url().endsWith("/api/state") ? state : operations,
      });
    });
    await page.goto("/");
    await page.getByLabel("管理トークン").fill("mock-only");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    // The connectivity summary is a strip on the dashboard tab only;
    // its detail list holds the per-item state the assertions read.
    await page
      .getByRole("button", { name: "ダッシュボード", exact: true })
      .click();
    const panel = page.getByLabel("通信とPAPER注文の状態");
    await panel.locator("summary").click();
    await expect(panel).toContainText("現在の通信状態");
    await expect(panel).toContainText(
      phase === "HEALTHY" ? "注文可能" : "注文禁止",
    );
    if (phase === "HEALTHY")
      await expect(panel).toContainText("安全確認が完了しました");
    else await expect(panel).not.toContainText("PAPER検証を再開しました");
    if (phase === "RECOVERING") await expect(panel).toContainText("1 / 2 周期");
    if (phase === "DEGRADED")
      await page.screenshot({
        path: info.outputPath("degraded.png"),
        fullPage: true,
      });
    expect(writes).toEqual([]);
    const width = await page.evaluate(() => ({
      window: innerWidth,
      content: document.documentElement.scrollWidth,
    }));
    expect(width.content).toBeLessThanOrEqual(width.window);
  });
}
