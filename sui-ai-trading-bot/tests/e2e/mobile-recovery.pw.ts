import { test, expect, type Locator, type Page } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
import { initialPaperSafety } from "../../packages/shared/src/paper-recovery.ts";

type Phase =
  | "DEGRADED"
  | "RECOVERING"
  | "RUNNING"
  | "MANUAL_STOP"
  | "EMERGENCY_STOP"
  | "ABNORMAL_STOP";

/** All UI envelopes come from the same worker, with no live upstream calls. */
function fixture(phase: Phase, autoResume = true, now = Date.now()) {
  const db = new BotDatabase(":memory:");
  const health = { healthy: true, checkedAt: now, failures: 0 };
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
  engine.monitor.boot(now);
  db.set("runtime", {
    ...db.runtime(),
    running: phase === "RUNNING",
    emergency: phase === "EMERGENCY_STOP",
    error: phase === "ABNORMAL_STOP" ? "PAPER_RECOVERY_EXHAUSTED" : null,
  });
  const paused = phase === "DEGRADED" || phase === "RECOVERING";
  db.set("paper_safety", {
    ...initialPaperSafety(),
    connectivity: paused ? phase : "HEALTHY",
    resumePending: paused && autoResume,
    healthyCycles: phase === "RECOVERING" ? 1 : phase === "RUNNING" ? 2 : 0,
    firstHealthyAt: phase === "RECOVERING" ? now - 30_000 : null,
    recoveredAt: phase === "RUNNING" ? now : null,
    lastStopReason:
      phase === "ABNORMAL_STOP" ? "PAPER_RECOVERY_EXHAUSTED" : null,
  });
  engine.monitor.market(now - 300_000, now);
  engine.monitor.transportSuccess(now);
  const state = engine.snapshot();
  const operations = engine.monitor.snapshot(now);
  db.close();
  return { state, operations };
}

async function open(page: Page, phase: Phase, autoResume = true) {
  await page.clock.install();
  let current = fixture(phase, autoResume);
  let currentPhase = phase;
  let failState = false;
  let refusal: string | null = null;
  const writes: Array<{ path: string; command?: string }> = [];
  let reads = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({ json: { authenticated: true } });
    if (request.method() !== "GET") {
      const command = request.postDataJSON()?.command;
      writes.push({ path, command });
      if (path === "/api/control") {
        if (command === "stop")
          current = fixture(
            currentPhase === "RUNNING" ? "MANUAL_STOP" : currentPhase,
            false,
          );
        return refusal
          ? route.fulfill({ status: 409, json: { error: refusal } })
          : route.fulfill({ json: current.state.runtime });
      }
      throw Error(`Unexpected write: ${path}`);
    }
    reads++;
    if (path === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
    if (path === "/api/state")
      return failState
        ? route.fulfill({ status: 503, json: { error: "HTTP_503" } })
        : route.fulfill({ json: current.state });
    if (path === "/api/operations")
      return route.fulfill({ json: current.operations });
    throw Error(`Unexpected API: ${path}`);
  });
  await page.goto("/");
  await expect(
    page.getByRole("region", { name: "復旧ガイド", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".operation-bar")).toBeVisible();
  return {
    writes,
    reads: () => reads,
    fail: (failed: boolean) => {
      failState = failed;
    },
    refuse: (code: string | null) => {
      refusal = code;
    },
    phase: async (next: Phase, pending = true) => {
      currentPhase = next;
      current = fixture(next, pending, await page.evaluate(() => Date.now()));
      await page.clock.runFor(10_000);
    },
  };
}

const guide = (page: Page) =>
  page.getByRole("region", { name: "復旧ガイド", exact: true });
const title = (page: Page) => guide(page).locator(".recovery-status-title");
const start = (page: Page) =>
  page.getByRole("button", { name: "PAPER運用開始", exact: true });

async function noOverlap(first: Locator, second: Locator) {
  const a = await first.boundingBox();
  const b = await second.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  const intersection =
    Math.min(a!.x + a!.width, b!.x + b!.width) > Math.max(a!.x, b!.x) &&
    Math.min(a!.y + a!.height, b!.y + b!.height) > Math.max(a!.y, b!.y);
  expect(intersection, JSON.stringify({ first: a, second: b })).toBe(false);
}

test("automatic PAPER recovery keeps the order gate closed until the backend confirms recovery", async ({
  page,
}, info) => {
  const api = await open(page, "DEGRADED");
  await expect(title(page)).toHaveText("通信異常");
  await expect(guide(page)).toContainText("原因");
  await expect(guide(page)).toContainText("安全状態");
  await expect(guide(page)).toContainText("次の操作");
  await expect(guide(page)).toContainText("自動");
  await expect(page.locator(".agent-feed-entry").first()).toContainText(
    "自動復旧",
  );
  await expect(page.locator(".agent-feed-entry").first()).not.toContainText(
    "開始操作を待って",
  );
  await expect(start(page)).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("communication-failure.png"),
    fullPage: true,
  });
  await api.phase("RECOVERING");
  await expect(title(page)).toHaveText("通信確認中");
  await expect(start(page)).toBeDisabled();
  await expect(guide(page)).toContainText("安全確認");
  await api.phase("RUNNING");
  await expect(guide(page)).toHaveCount(0);
  await expect(page.locator(".operation-bar")).toContainText("正常稼働");
  await expect(
    page.getByRole("button", { name: "PAPER運用停止", exact: true }),
  ).toBeEnabled();
  expect(api.writes).toEqual([]);
});

test("a manual stop needs a deliberate start after connectivity is confirmed", async ({
  page,
}) => {
  const api = await open(page, "RECOVERING", false);
  await expect(title(page)).toHaveText("通信確認中");
  await expect(start(page)).toBeDisabled();
  await expect(guide(page)).not.toContainText("自動再開します");
  await api.phase("MANUAL_STOP", false);
  await expect(title(page)).toHaveText("停止中");
  await expect(guide(page)).toContainText("開始");
  await expect(start(page)).toBeEnabled();
  expect(api.writes).toEqual([]);
});

test("the operator can cancel automatic recovery without opening the order gate", async ({
  page,
}) => {
  const api = await open(page, "DEGRADED");
  await guide(page)
    .getByRole("button", { name: "自動再開を取り消して停止", exact: true })
    .click();
  await expect(
    guide(page).getByRole("button", {
      name: "自動再開を取り消して停止",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(start(page)).toBeDisabled();
  await expect(guide(page)).toContainText("自動再開しません");
  await api.phase("MANUAL_STOP", false);
  await expect(title(page)).toHaveText("停止中");
  await expect(start(page)).toBeEnabled();
  expect(api.writes).toEqual([{ path: "/api/control", command: "stop" }]);
});

test("a failed state read is not asserted to be an upstream communication fault and can be retried read-only", async ({
  page,
}, info) => {
  const api = await open(page, "MANUAL_STOP");
  api.fail(true);
  await page.clock.runFor(10_000);
  await expect(title(page)).toHaveText("状態取得失敗");
  await expect(guide(page)).not.toContainText("通信異常を検出");
  await expect(start(page)).toBeDisabled();
  await page.screenshot({
    path: info.outputPath("state-read-failure.png"),
    fullPage: true,
  });
  const before = api.reads();
  api.fail(false);
  await guide(page)
    .getByRole("button", { name: "状態を再取得", exact: true })
    .click();
  await expect(title(page)).toHaveText("停止中");
  await expect(start(page)).toBeEnabled();
  expect(api.reads()).toBeGreaterThan(before);
  expect(api.writes).toEqual([]);
  await page.screenshot({
    path: info.outputPath("read-only-retry.png"),
    fullPage: true,
  });
});

test("a 409 start refusal keeps the known backend state and gives a direct diagnostics route", async ({
  page,
}, info) => {
  const api = await open(page, "MANUAL_STOP");
  api.refuse("PAPER_RECOVERY_REQUIRED");
  await start(page).click();
  await expect(page.locator(".operation-bar-failure")).toContainText(
    "安全確認が未完了",
  );
  await expect(title(page)).not.toHaveText("状態取得失敗");
  await expect(page.locator(".agent-avatar-pill")).not.toContainText(
    "状態不明",
  );
  await guide(page)
    .getByRole("button", { name: "通信診断を開く", exact: true })
    .click();
  await expect(page.locator("#operation-diagnostics")).toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator("#operation-diagnostics > summary")).toBeFocused();
  expect(api.writes).toEqual([{ path: "/api/control", command: "start" }]);
  await page.screenshot({
    path: info.outputPath("start-refusal-diagnostics.png"),
    fullPage: true,
  });
});

for (const phase of ["EMERGENCY_STOP", "ABNORMAL_STOP"] as const) {
  test(`${phase} never starts automatically and diagnostics do not release it`, async ({
    page,
  }) => {
    const api = await open(page, phase);
    await expect(title(page)).toHaveText("停止中");
    await expect(start(page)).toHaveCount(0);
    await expect(guide(page)).toContainText("自動再開しません");
    await guide(page)
      .getByRole("button", { name: "通信診断を開く", exact: true })
      .click();
    await expect(page.locator("#operation-diagnostics")).toHaveAttribute(
      "open",
      "",
    );
    expect(api.writes).toEqual([]);
  });
}

test("mobile recovery actions, avatar, bubble, status and bottom navigation do not overlap", async ({
  page,
}, info) => {
  const api = await open(page, "DEGRADED");
  const avatar = page.locator(".agent-avatar");
  const bubble = page.locator(".agent-avatar-bubble");
  const pill = page.locator(".agent-avatar-pill");
  await expect(bubble).toBeVisible();
  await noOverlap(avatar, pill);
  await noOverlap(bubble, pill);
  await noOverlap(bubble, page.locator(".operation-bar"));
  await noOverlap(pill, page.locator(".operation-bar"));
  const viewport = page.viewportSize()!;
  for (const action of await guide(page).getByRole("button").all()) {
    await action.scrollIntoViewIfNeeded();
    await noOverlap(action, page.locator("nav"));
    const bounds = await action.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    if (viewport.width <= 430)
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("recovery-layout.png"),
    fullPage: true,
  });
  expect(api.writes).toEqual([]);
});
