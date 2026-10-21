import { test, expect } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
import { ValidationRecorder } from "../../apps/worker/src/validation.ts";
for (const begun of [false, true])
  test(`DeepBook validation ${begun ? "partial report" : "explicit begin"} stays PAPER-only`, async ({
    page,
  }) => {
    const db = new BotDatabase(":memory:"),
      health = { healthy: true, checkedAt: Date.now(), failures: 0 };
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
    engine.monitor.boot();
    const recorder = new ValidationRecorder(db);
    if (begun) recorder.begin(Date.now() - 3600000);
    const operations = {
        ...engine.monitor.snapshot(),
        validation: recorder.report(),
      },
      state = engine.snapshot(),
      writes: string[] = [];
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") writes.push(path);
      if (path === "/api/validation/start")
        return route.fulfill({ json: { status: "検証途中" } });
      return route.fulfill({
        json: path === "/api/state" ? state : operations,
      });
    });
    await page.goto("/");
    await page.getByLabel("管理トークン").fill("test-only-no-real-token");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await page.getByRole("button", { name: "運用検証", exact: true }).click();
    const panel = page.getByRole("region", { name: "DeepBook 24時間検証" });
    await expect(panel).toBeVisible();
    if (begun) {
      await expect(panel).toContainText("検証途中");
      await expect(panel).toContainText("未行使");
      await expect(
        panel.getByRole("progressbar", { name: "24時間の進捗" }),
      ).toHaveAttribute("max", "1");
      const downloaded = page.waitForEvent("download");
      await panel.getByRole("button", { name: "検証Markdownを保存" }).click();
      expect((await downloaded).suggestedFilename()).toBe("deepbook-24h.md");
      expect(writes).toEqual([]);
    } else {
      await expect(panel).toContainText("未開始");
      expect(writes).toEqual([]);
      await panel.getByRole("button", { name: "24時間計測を開始" }).click();
      await expect(panel).toContainText("PAPER運用は別途、手動で開始");
      expect(writes).toEqual(["/api/validation/start"]);
    }
    const dims = await page.evaluate(() => ({
      width: innerWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(dims.scroll).toBeLessThanOrEqual(dims.width);
    db.close();
  });
