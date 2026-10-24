import { expect, test } from "@playwright/test";
import { validationFixture } from "../deepbook-ui-fixture.ts";

for (const go of [false, true]) {
  test(`control flow with ${go ? "mock GO" : "release NO-GO"}`, async ({
    page,
  }, info) => {
    let fixture = validationFixture("unstarted");
    const writes: { path: string; body: unknown; auth: string | undefined }[] =
      [];
    // Isolated GO branch coverage only. Production release remains NO-GO.
    if (go)
      await page.route("**/src/validationControl.ts*", async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(
          'status: "NO_GO"',
          'status: "GO"',
        );
        await route.fulfill({ response, body });
      });
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === "POST") {
        const body = req.postDataJSON();
        writes.push({ path, body, auth: req.headers().authorization });
        if (path.endsWith("/validation/start"))
          fixture = validationFixture("stopped");
        if (body.command === "start") fixture = validationFixture("running");
        if (body.command === "stop") fixture = validationFixture("stopped");
      }
      fixture.state.connection.checkedAt = Date.now();
      fixture.state.runtime.running = fixture.operations.status === "RUNNING";
      return route.fulfill({
        json: path.endsWith("/state") ? fixture.state : fixture.operations,
      });
    });
    await page.goto("/");
    await page.getByLabel("管理トークン").fill("test-only-no-real-token");
    await page.getByRole("button", { name: "接続", exact: true }).click();
    await page.getByRole("button", { name: "運用検証", exact: true }).click();
    const control = page.getByRole("region", { name: "運用検証コントロール" });
    await expect(control).toBeVisible();
    const measure = control.getByRole("button", {
      name: "24時間計測を開始",
      exact: true,
    });
    const start = control.getByRole("button", {
      name: "PAPER Botを開始",
      exact: true,
    });
    if (!go) {
      await expect(measure).toBeDisabled();
      await expect(start).toBeDisabled();
      await control
        .getByText("開始条件・操作の説明・過去の停止理由", { exact: true })
        .click();
      await expect(control).toContainText("NO-GO（開始禁止）");
      expect(writes).toEqual([]);
    } else {
      await expect(measure).toBeEnabled();
      await expect(start).toBeDisabled();
      await measure.click();
      expect(writes).toEqual([]);
      await control.getByRole("button", { name: "キャンセル" }).click();
      expect(writes).toEqual([]);
      await measure.click();
      await control.getByRole("button", { name: "確認して実行" }).click();
      await expect(start).toBeEnabled();
      await expect(measure).toHaveCount(0);
      await expect(control).toContainText("計測だけが進行しています");
      expect(writes.map((w) => w.path)).toEqual(["/api/validation/start"]);
      await start.click();
      await control.getByRole("button", { name: "確認して実行" }).click();
      await expect(control.locator(".control-state")).toContainText("稼働中");
      await expect(start).toHaveCount(0);
      await expect(control.locator(".control-steps")).toHaveCount(0);
      await expect(control.locator(".control-details")).not.toHaveAttribute(
        "open",
        "",
      );
      expect((await control.boundingBox())!.height).toBeLessThan(
        info.project.name === "width-375" ? 450 : 400,
      );
      await control.screenshot({
        path: `test-results/control-${info.project.name}.png`,
      });
      await control
        .getByRole("button", { name: "PAPER Botを停止", exact: true })
        .click();
      await control.getByRole("button", { name: "確認して実行" }).click();
      await expect(control.locator(".control-state")).toContainText("開始可能");
      await page.clock.install();
      await page.clock.fastForward(21000);
      await expect(control).toContainText("計測だけが進行しています");
      expect(writes.map((w) => [w.path, w.body])).toEqual([
        ["/api/validation/start", {}],
        ["/api/control", { command: "start" }],
        ["/api/control", { command: "stop" }],
      ]);
      expect(
        writes.every((w) => w.auth === "Bearer test-only-no-real-token"),
      ).toBe(true);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await control.screenshot({ path: info.outputPath("control.png") });
  });
}

test("abnormal stop requires confirmed RESET and never auto starts", async ({
  page,
}) => {
  let fixture = validationFixture("safety-stop");
  const commands: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      commands.push(route.request().postDataJSON());
      fixture = validationFixture("stopped");
    }
    fixture.state.connection.checkedAt = Date.now();
    await route.fulfill({
      json: path.endsWith("/state") ? fixture.state : fixture.operations,
    });
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only-no-real-token");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await page.getByRole("button", { name: "運用検証", exact: true }).click();
  const control = page.getByRole("region", { name: "運用検証コントロール" });
  await expect(control.locator(".control-state")).toContainText(
    "異常・緊急停止",
  );
  await expect(
    control.getByRole("button", { name: "PAPER Botを開始", exact: true }),
  ).toBeDisabled();
  await control
    .getByRole("button", { name: "RESET：停止状態を解除", exact: true })
    .click();
  expect(commands).toEqual([]);
  await control.getByRole("button", { name: "確認して実行" }).click();
  await expect(control).toContainText("Botは停止したまま");
  expect(commands).toEqual([{ command: "reset" }]);
});

test("stale confirmation blocks a start; landscape and keyboard remain usable", async ({
  page,
}) => {
  const fixture = validationFixture("unstarted");
  let unavailable = false;
  const writes: string[] = [];
  await page.setViewportSize({ width: 812, height: 375 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await page.route("**/src/validationControl.ts*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: (await response.text()).replace('status: "NO_GO"', 'status: "GO"'),
    });
  });
  await page.route("**/api/**", async (route) => {
    if (route.request().method() !== "GET") writes.push(route.request().url());
    if (unavailable && route.request().url().endsWith("/operations"))
      return route.fulfill({ status: 503, json: { error: "UNAVAILABLE" } });
    fixture.state.connection.checkedAt = Date.now();
    await route.fulfill({
      json: route.request().url().endsWith("/state")
        ? fixture.state
        : fixture.operations,
    });
  });
  await page.goto("/");
  await page.getByLabel("管理トークン").fill("test-only-no-real-token");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await page.getByRole("button", { name: "運用検証", exact: true }).click();
  const control = page.getByRole("region", { name: "運用検証コントロール" });
  await control
    .getByRole("button", { name: "24時間計測を開始", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "24時間計測を開始の確認" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "確認して実行" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await control
    .getByRole("button", { name: "24時間計測を開始", exact: true })
    .click();
  unavailable = true;
  await page.clock.fastForward(11000);
  await expect(
    dialog.getByRole("button", { name: "確認して実行" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(control.locator(".control-state")).toContainText("状態不明");
  await expect(
    control.getByRole("button", { name: "PAPER Botを停止", exact: true }),
  ).toBeEnabled();
  expect(writes).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
