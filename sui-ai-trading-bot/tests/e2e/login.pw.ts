import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
const fixture =
  "/@fs/" + resolve("tests/e2e/fixtures/login.html").replaceAll("\\", "/");
async function open(page: Page) {
  await page.goto(fixture);
  await expect(page.getByLabel("管理トークン")).toBeVisible();
}
async function submit(page: Page, token: string) {
  await page.getByLabel("管理トークン").fill(token);
  await page.getByRole("button", { name: "接続", exact: true }).click();
}
async function settle(page: Page, index: number, ok = true) {
  await page.evaluate(
    ({ index, ok }) =>
      window.loginHarness.pending[index].resolve(
        ok ? { ok: true } : { ok: false, code: "UNAUTHORIZED" },
      ),
    { index, ok },
  );
}
test("same-task submits are single-flight, controls lock, success notifies once", async ({
  page,
}) => {
  await open(page);
  await page.getByLabel("管理トークン").fill("test-token");
  await page.locator("form").evaluate((form) => {
    for (let i = 0; i < 5; i++)
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
  });
  expect(await page.evaluate(() => window.loginHarness.pending.length)).toBe(1);
  await expect(page.getByLabel("管理トークン")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "接続", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "パターンを登録する", exact: true }),
  ).toHaveCount(0);
  await settle(page, 0);
  await expect
    .poll(() => page.evaluate(() => window.loginHarness.authenticated))
    .toEqual(["test-token"]);
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(() => window.loginHarness.authenticated.length),
  ).toBe(1);
});
for (const staleFirst of [true, false]) {
  test(`cancel then retry ignores old success/failed result; staleFirst=${staleFirst}`, async ({
    page,
  }) => {
    await open(page);
    await submit(page, "old-token");
    await page.getByRole("button", { name: "認証を取り消す" }).click();
    expect(
      await page.evaluate(() => window.loginHarness.pending[0].signal?.aborted),
    ).toBe(true);
    await submit(page, "new-token");
    if (staleFirst) {
      await settle(page, 0);
      await expect(page.getByLabel("管理トークン")).toBeDisabled();
      expect(
        await page.evaluate(() => window.loginHarness.authenticated),
      ).toEqual([]);
    }
    await settle(page, 1);
    await expect
      .poll(() => page.evaluate(() => window.loginHarness.authenticated))
      .toEqual(["new-token"]);
    if (!staleFirst) await settle(page, 0, false);
    expect(
      await page.evaluate(() => window.loginHarness.authenticated),
    ).toEqual(["new-token"]);
    await expect(page.locator("#login-error")).toHaveCount(0);
  });
}
test("cancel during success animation invalidates its delayed notification", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page);
  await submit(page, "test-token");
  await settle(page, 0);
  await expect(page.getByRole("status")).toHaveText("おはようございます！");
  await page.getByRole("button", { name: "認証を取り消す" }).click();
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.loginHarness.authenticated)).toEqual(
    [],
  );
  await expect(page.getByLabel("管理トークン")).toBeEnabled();
});
test("unmount invalidates pending results and aborts transport", async ({
  page,
}) => {
  await page.clock.install();
  await open(page);
  await submit(page, "test-token");
  await page.evaluate(() => window.loginHarness.hide());
  await expect(page.locator(".login-gate")).toHaveCount(0);
  // DOM removal can precede React's passive-effect cleanup, notably on WebKit.
  await expect
    .poll(() =>
      page.evaluate(() => window.loginHarness.pending[0].signal?.aborted),
    )
    .toBe(true);
  await settle(page, 0);
  // A stale success must not notify, even after the longest success delay.
  await page.clock.runFor(1000);
  expect(await page.evaluate(() => window.loginHarness.authenticated)).toEqual(
    [],
  );
  await page.evaluate(() => window.loginHarness.mount());
  await submit(page, "new-token");
  await settle(page, 1);
  await page.clock.runFor(1000);
  await expect
    .poll(() => page.evaluate(() => window.loginHarness.authenticated))
    .toEqual(["new-token"]);
});
test("unmount cancels the success timer", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open(page);
  await submit(page, "test-token");
  await settle(page, 0);
  await expect(page.getByRole("status")).toHaveText("おはようございます！");
  await page.evaluate(() => window.loginHarness.hide());
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => window.loginHarness.authenticated)).toEqual(
    [],
  );
});
test("a rejected verifier recovers and allows retry", async ({ page }) => {
  await open(page);
  await submit(page, "test-token");
  await page.evaluate(() =>
    window.loginHarness.pending[0].reject(Error("offline")),
  );
  await expect(page.locator("#login-error")).toContainText("NETWORK");
  await submit(page, "retry-token");
  await settle(page, 1);
  await expect
    .poll(() => page.evaluate(() => window.loginHarness.authenticated))
    .toEqual(["retry-token"]);
});
test("removes malformed legacy data without WebCrypto and never registers again", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("suiba.patternLock.v1", "{malformed-ciphertext");
    localStorage.setItem("suiba.patternLock.dismissed", "1");
    localStorage.setItem("unrelated", "keep");
    Object.defineProperty(crypto, "subtle", { value: undefined });
  });
  await open(page);
  await expect(page.getByText(/暗号化トークンを削除しました/)).toBeVisible();
  expect(
    await page.evaluate(() => [
      localStorage.getItem("suiba.patternLock.v1"),
      localStorage.getItem("suiba.patternLock.dismissed"),
      localStorage.getItem("unrelated"),
    ]),
  ).toEqual([null, null, "keep"]);
  await submit(page, "memory-only-token");
  await settle(page, 0);
  await expect
    .poll(() => page.evaluate(() => window.loginHarness.authenticated.length))
    .toBe(1);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([
    "unrelated",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("blocked browser storage still allows token login and gives deletion guidance", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    }),
  );
  await open(page);
  await expect(page.getByRole("alert")).toContainText(
    "保存データを削除できませんでした",
  );
  await submit(page, "test-token");
  await settle(page, 0);
  await expect
    .poll(() => page.evaluate(() => window.loginHarness.authenticated))
    .toEqual(["test-token"]);
});
test("real App retries after invalid responses, 401, disconnection and timeout", async ({
  page,
}) => {
  let mode = "invalid";
  await page.route("**/api/**", async (route) => {
    if (mode === "network") return route.abort();
    if (mode === "timeout") {
      await new Promise((r) => setTimeout(r, 8500));
      return route.abort().catch(() => {});
    }
    return route.fulfill({
      status: mode === "unauthorized" ? 401 : 200,
      contentType: mode === "html" ? "text/html" : "application/json",
      body:
        mode === "invalid"
          ? "null"
          : mode === "html"
            ? "<html>wrong</html>"
            : "{bad",
    });
  });
  await page.goto("/");
  for (const [next, code] of [
    ["invalid", "INVALID_RESPONSE"],
    ["html", "INVALID_RESPONSE"],
    ["unauthorized", "UNAUTHORIZED"],
    ["network", "NETWORK"],
    ["timeout", "TIMEOUT"],
  ]) {
    mode = next;
    await submit(page, "test-token");
    await expect(page.locator("#login-error")).toContainText(code, {
      timeout: 11000,
    });
    await expect(page.getByLabel("管理トークン")).toBeEnabled();
  }
});
