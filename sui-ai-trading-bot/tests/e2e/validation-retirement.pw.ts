import { test, expect } from "@playwright/test";
import { dashboardPreviewFixture } from "../../scripts/dashboard-preview-fixture.ts";

test("five tabs retain freshness, stop history and shared header start/stop", async ({
  page,
}) => {
  const { state, operations } = dashboardPreviewFixture();
  const commands: string[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({ json: { authenticated: true } });
    if (path === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    if (path === "/api/state") return route.fulfill({ json: state });
    if (path === "/api/operations") return route.fulfill({ json: operations });
    if (path === "/api/control") {
      const { command } = route.request().postDataJSON();
      commands.push(command);
      state.runtime.running = command === "start";
      return route.fulfill({ json: state.runtime });
    }
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  await page.goto("/");
  await expect(page.locator("nav button[aria-label]")).toHaveCount(5);
  await expect(
    page.getByRole("button", { name: "運用検証", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Workerの状態" }),
  ).toContainText("最終分析成功");
  await expect(
    page.getByRole("region", { name: "Workerの状態" }),
  ).toContainText("Workerの心拍");
  await page.getByRole("button", { name: "取引履歴", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "過去の停止理由" }),
  ).toContainText("解除済み");
  await expect(
    page.getByRole("region", { name: "過去の停止理由" }),
  ).toContainText("直近7日間");
  await page
    .getByRole("button", { name: "PAPER運用開始", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "PAPER運用停止", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "PAPER運用停止", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "PAPER運用開始", exact: true }),
  ).toBeVisible();
  expect(commands).toEqual(["start", "stop"]);
});
