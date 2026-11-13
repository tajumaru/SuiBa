import { test, expect } from "@playwright/test";
import { validationFixture } from "../deepbook-ui-fixture.ts";

for (const initialFailure of [false, true]) {
  test(`connection loss reconnects without reload (initial failure: ${initialFailure})`, async ({
    page,
  }, info) => {
    const { state, operations } = validationFixture("running");
    state.price = 1.2345;
    let offline = initialFailure;
    const calls: string[] = [];
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations++;
    });
    await page.clock.install();
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      // Session auth remains available in this synthetic test; actual refused
      // TCP connections are covered separately with a stopped local worker.
      if (path === "/api/auth/session")
        return route.fulfill({ json: { authenticated: true } });
      calls.push(path);
      if (offline) return route.abort("connectionfailed");
      if (path === "/api/dashboard/summary")
        return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
      return route.fulfill({
        json: path === "/api/state" ? state : operations,
      });
    });
    await page.goto("/");
    const notice = page.locator(".connection-notice");
    if (!initialFailure) {
      await expect(page.locator(".price-ticker-price")).toHaveText("$1.2345");
      // A Bot-side stale condition is not a browser connection outage.
      state.runtime.error = "CANDLE_STALE";
      await page.clock.runFor(11000);
      await expect(notice).toHaveCount(0);
      offline = true;
      await page.clock.runFor(11000);
    }
    await expect(notice).toContainText("再起動中の可能性");
    if (initialFailure)
      await expect(notice).toContainText("まだデータを取得できていません");
    else {
      await expect(notice).toContainText("接続断前の情報");
      await expect(page.locator("main")).toHaveAttribute(
        "data-connection-stale",
        "true",
      );
      await expect(page.locator(".price-ticker-price")).toHaveText("$1.2345");
    }
    const receipt = initialFailure
      ? null
      : await notice.locator("time").getAttribute("datetime");
    const count = calls.length;
    for (let i = 0; i < 4; i++) {
      await page.clock.runFor(11000);
      await expect(notice).toBeVisible();
    }
    expect(calls.length - count).toBeLessThanOrEqual(4);
    expect(
      calls
        .slice(count)
        .every((path) =>
          ["/api/dashboard/summary", "/api/state"].includes(path),
        ),
    ).toBe(true);
    if (receipt)
      await expect(notice.locator("time")).toHaveAttribute("datetime", receipt);
    await page.screenshot({
      path: info.outputPath("disconnected.png"),
      fullPage: true,
    });
    offline = false;
    state.price = 2.3456;
    state.runtime.error = null;
    await page.clock.runFor(32000);
    await expect(notice).toHaveCount(0);
    await expect(page.locator(".price-ticker-price")).toHaveText("$2.3456");
    await expect(page.locator("main")).toHaveAttribute(
      "data-connection-stale",
      "false",
    );
    await page.clock.runFor(4000);
    await expect(page.locator(".narration-tab .error")).toHaveCount(0);
    expect(navigations).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("reconnected.png"),
      fullPage: true,
    });
  });
}
