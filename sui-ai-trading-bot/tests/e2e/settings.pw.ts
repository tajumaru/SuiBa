import { test, expect, type Page } from "@playwright/test";
import {
  defaults,
  settingsSchema,
  type Settings,
} from "../../packages/shared/src/index.ts";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";

// The settings editor lives on the strategy tab since the two tabs
// merged; opening it means navigating to 戦略 and switching the
// page's segment from ルール to 設定, which reveals the
// かんたん設定 area. (PAPER start/stop stays visible below the
// segments, so operation flows need no segment switch.)
async function openSettings(
  page: Page,
  initial: Settings = {
    ...defaults,
    dailyLossPct: 0.002,
    maxHoldingRatio: 0.08,
    stopLossPct: 0.017,
  },
) {
  const db = new BotDatabase(":memory:");
  db.updateSettings(initial);
  const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const state = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw new Error("UNUSED");
      },
      validateQuote: async () => false,
    },
    { health: async () => health, status: health },
  ).snapshot();
  db.close();
  const writes: Settings[] = [],
    commands: string[] = [];
  let failure: "none" | "post" | "read" = "none",
    hold: Promise<void> | undefined;
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/state") {
      if (failure === "read" && writes.length) {
        await route.abort();
        return;
      }
      await route.fulfill({ json: state });
      return;
    }
    if (path === "/api/settings") {
      writes.push(route.request().postDataJSON());
      if (hold) await hold;
      if (failure === "post") {
        await route.fulfill({ status: 500, json: { error: "REQUEST_FAILED" } });
        return;
      }
      state.settings = settingsSchema.parse(writes.at(-1));
      await route.fulfill({ json: state.settings });
      return;
    }
    if (path === "/api/control") {
      const command = route.request().postDataJSON().command;
      commands.push(command);
      state.runtime = {
        ...state.runtime,
        running: command === "start" && !state.runtime.emergency,
        emergency: command === "emergency" || state.runtime.emergency,
      };
      await route.fulfill({ json: state.runtime });
      return;
    }
    throw new Error(`Unexpected API ${path}`);
  });
  await page.goto("/");
  await page
    .getByLabel("管理トークン")
    .fill("e2e-test-only-no-real-credential");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await page.getByRole("button", { name: "戦略", exact: true }).click();
  await page.getByRole("tab", { name: "設定", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "かんたん設定", exact: true }),
  ).toBeVisible();
  return {
    writes,
    commands,
    state,
    setFailure: (next: typeof failure) => {
      failure = next;
    },
    holdSave: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}
const modes = (page: Page) =>
  page
    .getByRole("group", { name: "運用スタイル", exact: true })
    .getByRole("button");
const maximum = (page: Page) =>
  page.getByRole("spinbutton", { name: /^1回の最大取引額/ });
const planned = (page: Page) =>
  page.getByLabel("適用予定の設定", { exact: true });
const saved = (page: Page) =>
  page.getByLabel("保存済みの設定", { exact: true });
const review = (page: Page) =>
  page.getByRole("group", { name: "保存前の変更内容確認", exact: true });

// Every test runs at all three requested phone widths and at desktop width.
test("recommends safe settings without guessing first use, and previews without saving or starting", async ({
  page,
}) => {
  const api = await openSettings(page);
  await expect(page.getByLabel("安全重視のおすすめ")).toContainText(
    "初めての方には安全重視がおすすめ",
  );
  await expect(page.locator("legend")).toContainText("保存済み：カスタム");
  await expect(maximum(page)).toHaveValue("5");
  await page
    .getByRole("button", { name: "安全重視の設定を確認する", exact: true })
    .click();
  await expect(modes(page).nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(planned(page)).toContainText("適用予定：安全重視（未保存）");
  await expect(planned(page)).toContainText("5 USDC → 2 USDC");
  await expect(planned(page)).toContainText("20 USDC → 10 USDC");
  await expect(planned(page)).toContainText("1 % → 1.5 %");
  await expect(maximum(page)).toHaveValue("2");
  await expect(saved(page)).toContainText("最大取引額：5 USDC");
  await expect(
    page.getByRole("button", { name: "PAPER運用開始", exact: true }),
  ).toBeDisabled();
  expect(api.writes).toHaveLength(0);
  expect(api.commands).toHaveLength(0);
  await page
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  await expect(review(page)).toContainText("保存前の確認");
  expect(api.writes).toHaveLength(0);
  expect(api.commands).toHaveLength(0);
  await page.reload();
  await page
    .getByLabel("管理トークン")
    .fill("e2e-test-only-no-real-credential");
  await page.getByRole("button", { name: "接続", exact: true }).click();
  await page.getByRole("button", { name: "戦略", exact: true }).click();
  await page.getByRole("tab", { name: "設定", exact: true }).click();
  await expect(maximum(page)).toHaveValue("5");
  expect(api.writes).toHaveLength(0);
  expect(api.commands).toHaveLength(0);
});

test("confirms, prevents duplicate saving, rereads settings, then starts only on explicit operation", async ({
  page,
}) => {
  const api = await openSettings(page);
  await modes(page).nth(0).click();
  await page
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  const release = api.holdSave();
  await review(page)
    .getByRole("button", { name: "安全重視を適用", exact: true })
    .click();
  await expect(
    page.locator(".easy-settings").getByRole("status"),
  ).toContainText("保存・サーバーへの再確認中");
  await expect(
    review(page).getByRole("button", { name: "安全重視を適用", exact: true }),
  ).toBeDisabled();
  await expect(modes(page).nth(1)).toBeDisabled();
  await expect.poll(() => api.writes.length).toBe(1);
  expect(api.commands).toHaveLength(0);
  release();
  await expect(
    page.locator(".easy-settings").getByRole("status"),
  ).toContainText("適用済み：安全重視");
  await expect(saved(page)).toContainText("最大取引額：2 USDC");
  expect(api.state.settings).toMatchObject({
    dailyLossPct: 0.002,
    maxHoldingRatio: 0.08,
    stopLossPct: 0.017,
    profitGuardEnabled: true,
    minNetProfitPct: 0.015,
  });
  expect(api.writes).toHaveLength(1);
  expect(api.commands).toHaveLength(0);
  await page
    .getByRole("button", { name: "PAPER運用開始", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "PAPER運用：運用中", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "PAPER運用停止", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "PAPER運用：停止中", exact: true }),
  ).toBeVisible();
  expect(api.commands).toEqual(["start", "stop"]);
});

for (const failure of ["post", "read"] as const)
  test(`does not display applied after ${failure} failure`, async ({
    page,
  }) => {
    const api = await openSettings(page);
    api.setFailure(failure);
    await modes(page).nth(0).click();
    await page
      .getByRole("button", { name: "変更内容を確認", exact: true })
      .click();
    await review(page)
      .getByRole("button", { name: "安全重視を適用", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "設定を保存・再確認できませんでした",
    );
    await expect(page.locator(".settings-success")).toHaveCount(0);
    await expect(saved(page)).toContainText("最大取引額：5 USDC");
    expect(api.commands).toHaveLength(0);
    api.setFailure("none");
    await review(page)
      .getByRole("button", { name: "安全重視を適用", exact: true })
      .click();
    await expect(
      page.locator(".easy-settings").getByRole("status"),
    ).toContainText("適用済み：安全重視");
  });

test("keeps custom edits until an explicit discard and uses saved settings for mode switches", async ({
  page,
}) => {
  const api = await openSettings(page);
  await maximum(page).fill("4");
  await modes(page).nth(0).click();
  const warning = page.getByRole("group", {
    name: "未保存変更の確認",
    exact: true,
  });
  await expect(warning).toContainText("未保存変更は破棄されます");
  await expect(maximum(page)).toHaveValue("4");
  await warning
    .getByRole("button", { name: "編集を続ける", exact: true })
    .click();
  await expect(maximum(page)).toHaveValue("4");
  await modes(page).nth(0).click();
  await warning
    .getByRole("button", {
      name: "未保存の変更を破棄して切り替える",
      exact: true,
    })
    .click();
  await expect(maximum(page)).toHaveValue("2");
  await page.getByText("詳細設定を開く", { exact: true }).click();
  await page.getByRole("spinbutton", { name: /^PAPERガス代/ }).fill("0.06");
  await expect(modes(page).nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(planned(page)).toContainText("適用予定：カスタム");
  await page
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  await review(page)
    .getByRole("button", { name: "変更を保存", exact: true })
    .click();
  await expect(
    page.locator(".easy-settings").getByRole("status"),
  ).toContainText("適用済み：カスタム");
  expect(api.state.settings.gasUsdc).toBe(0.06);
  await maximum(page).fill("3");
  await modes(page).nth(0).click();
  await warning
    .getByRole("button", {
      name: "未保存の変更を破棄して切り替える",
      exact: true,
    })
    .click();
  await modes(page).nth(1).click();
  await expect(warning).toHaveCount(0);
  await expect(maximum(page)).toHaveValue("2");
  await expect(
    page.getByRole("spinbutton", { name: /^PAPERガス代/ }),
  ).toHaveValue("0.06");
  expect(api.commands).toHaveLength(0);
});

test("validates values and keeps emergency stop independent during saving", async ({
  page,
}) => {
  const api = await openSettings(page);
  await maximum(page).fill("6");
  await page
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("設定値が不正");
  expect(api.writes).toHaveLength(0);
  await page
    .getByRole("button", {
      name: "未保存の変更を破棄して保存済みに戻す",
      exact: true,
    })
    .click();
  await modes(page).nth(0).click();
  await page
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  const release = api.holdSave();
  await review(page)
    .getByRole("button", { name: "安全重視を適用", exact: true })
    .click();
  await expect(
    page.locator(".easy-settings").getByRole("status"),
  ).toContainText("保存・サーバーへの再確認中");
  await page.getByRole("button", { name: "緊急停止", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "PAPER運用：緊急停止中", exact: true }),
  ).toBeVisible();
  release();
  await expect(
    page.locator(".easy-settings").getByRole("status"),
  ).toContainText("適用済み");
  await expect(
    page.getByRole("button", { name: "PAPER運用開始", exact: true }),
  ).toBeDisabled();
  expect(api.commands).toEqual(["emergency"]);
});

test("fits the viewport with 44px controls, decimal keyboard and wrapping preview/review/errors", async ({
  page,
}, testInfo) => {
  const api = await openSettings(page);
  api.setFailure("post");
  const assertFits = async () =>
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  await assertFits();
  await modes(page).nth(0).click();
  await assertFits();
  await expect(maximum(page)).toHaveAttribute("inputmode", "decimal");
  await page
    .getByRole("button", { name: "変更内容を確認", exact: true })
    .click();
  await page.getByText("詳細設定を開く", { exact: true }).click();
  await assertFits();
  for (const button of await page
    .locator(".easy-settings button:visible")
    .all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  const first = (await modes(page).nth(0).boundingBox())!,
    second = (await modes(page).nth(1).boundingBox())!;
  if (page.viewportSize()!.width < 600) {
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height);
    expect(second.x).toBe(first.x);
  }
  await review(page)
    .getByRole("button", { name: "安全重視を適用", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "設定を保存・再確認できませんでした",
  );
  await assertFits();
  await page.screenshot({
    path: testInfo.outputPath("settings-error-full.png"),
    fullPage: true,
  });
  expect(api.commands).toHaveLength(0);
});
