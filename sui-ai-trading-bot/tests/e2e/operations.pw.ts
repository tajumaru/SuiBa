import { test, expect, type Page } from "@playwright/test";
import { BotDatabase } from "../../packages/database/src/index.ts";
import { BotEngine } from "../../apps/worker/src/engine.ts";
import type { CandidateAudit } from "../../packages/shared/src/operations.ts";
import type { OperationsSnapshot } from "../../apps/dashboard/src/operationsTypes.ts";

async function open(
  page: Page,
  status: "STOPPED" | "RUNNING" | "DATA_DELAYED" | "ABNORMAL_STOP",
  limited = false,
  networkFailure = false,
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
    reasons: ["PROFIT_GUARD_PROJECTED_NET_INSUFFICIENT"],
  };
  db.putCandidate(candidate);
  const state = engine.snapshot(),
    operations = engine.monitor.snapshot();
  if (status === "RUNNING") {
    operations.safety.ordersAllowed = true;
    operations.safety.connectivity = "HEALTHY";
    operations.timing.dataStatus = "FRESH";
    operations.timing.transportRecent = true;
    operations.lastHeartbeatAt = Date.now();
    operations.lastMarketClosedAt = Date.now() - 300_000;
    operations.timing.lastTransportSuccessAt = Date.now();
  }
  if (limited) {
    operations.stopReason = "UPSTREAM_HTTP_429";
    operations.apis[1] = {
      ...operations.apis[1],
      requests: 7,
      rateLimits: 2,
      retries: 1,
      backoff: true,
      nextRetryAt: Date.now() + 30000,
      failed: true,
    };
  }
  if (networkFailure) {
    operations.stopReason = "UPSTREAM_DNS_FAILED";
    operations.apis[1].failed = true;
    operations.apis[1].lastFailure = {
      api: "GeckoTerminal",
      host: "api.geckoterminal.com",
      url: "https://api.geckoterminal.com/api/v2/networks/sui-network/pools/0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443/ohlcv/minute?aggregate=5&limit=1000&currency=token&token=quote&include_empty_intervals=false",
      method: "GET",
      operation: "OHLCV_5M",
      code: "UPSTREAM_DNS_FAILED",
      causeCode: "EAI_AGAIN",
      phase: "DNS",
      status: null,
      elapsedMs: 42,
      occurredAt: Date.now(),
    };
  }
  db.close();
  let fail = false;
  let authenticated = false;
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/api/auth/session") {
      if (route.request().method() === "POST") authenticated = true;
      if (route.request().method() === "DELETE") authenticated = false;
      return route.fulfill({
        status: authenticated ? 200 : 401,
        json: { authenticated },
      });
    }
    if (new URL(route.request().url()).pathname === "/api/dashboard/summary")
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
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
    page.getByRole("region", { name: "運用状態", exact: true }),
  ).toBeVisible();
  return {
    writes,
    state,
    fail: () => {
      fail = true;
    },
  };
}
test("overview omits the duplicate status card and retains diagnostics navigation", async ({
  page,
}) => {
  await open(page, "STOPPED");
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  const status = page.getByRole("region", {
    name: "通信とPAPER注文の状態",
    exact: true,
  });
  await expect(status).toHaveCount(0);
  await page.getByRole("button", { name: "運用検証", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "運用状態", exact: true }),
  ).toBeVisible();
});

test("history fits the phone width including reasons and expanded technical details", async ({
  page,
}, info) => {
  const { state } = await open(page, "STOPPED");
  state.orders.push({
    timestamp: Date.now(),
    side: "BUY",
    status: "REJECTED",
    reasons: ["PROFIT_GUARD_PROJECTED_NET_INSUFFICIENT"],
    id: "long-order-id-".repeat(20),
  });
  state.trades.push({
    orderId: "fill",
    side: "BUY",
    timestamp: Date.now(),
    quantity: 123.456789,
    price: 2.123456,
    fee: 0.03,
    pnl: null,
    slippage: 0,
    priceImpact: 0,
    allocatedCostUsdc: "12345678901234567890.123456789",
  });
  await page.reload();
  await page.getByRole("button", { name: "取引履歴", exact: true }).click();
  const orders = page.getByRole("table", { name: "注文履歴", exact: true });
  await expect(orders).toContainText("拒否");
  await expect(orders).toContainText(
    "手数料を払うと、十分に儲からないので見送りました",
  );
  await orders.getByText("注文の技術情報", { exact: true }).click();
  await expect(orders.locator("pre")).toBeVisible();
  if (page.viewportSize()!.width <= 600) {
    const dimensions = await page
      .locator(".history-scroll")
      .evaluateAll((elements) =>
        elements.map((e) => ({
          width: e.clientWidth,
          content: e.scrollWidth,
          left: e.getBoundingClientRect().left,
          right: e.getBoundingClientRect().right,
        })),
      );
    for (const box of dimensions) {
      expect(box.content).toBeLessThanOrEqual(box.width + 1);
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    await expect(orders.locator("tbody td[data-label='理由']")).toHaveCSS(
      "display",
      "block",
    );
  } else {
    await expect(orders).toHaveCSS("display", "table");
  }
  await orders.getByText("注文の技術情報", { exact: true }).click();
  await orders.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: info.outputPath("history.png"),
    fullPage: true,
  });
});

for (const [status, tone, message] of [
  ["STOPPED", "stopped", "Botは停止しています"],
  ["RUNNING", "healthy", "売買条件を満たした場合のみPAPERで仮想売買します"],
  ["DATA_DELAYED", "warning", "注文に必要なデータ・安全条件を確認しています"],
  ["ABNORMAL_STOP", "error", "照合で不整合を検出したため停止"],
] as const) {
  test(`displays ${status}, zero-trade reports, sanitized candidate reasons and atomic tolerances`, async ({
    page,
  }, info) => {
    const api = await open(page, status);
    // The hero's big state headline was removed as a duplicate of the
    // operation bar; the hero now carries the state through its tone
    // class and message instead.
    const hero = page.locator(".operation-hero");
    await expect(hero).toHaveClass(new RegExp(tone));
    await expect(hero).toContainText(message);
    await expect(
      page.getByRole("article", { name: "24時間レポート" }),
    ).toContainText("0件");
    await page.getByRole("button", { name: "7日間", exact: true }).click();
    await expect(
      page.getByRole("article", { name: "7日間レポート" }),
    ).toContainText("0件");
    await expect(
      page.getByText(
        "取引ゼロ件だけでは正常・異常を判断できません。売買がなくても条件を自動で緩めません。",
        { exact: true },
      ),
    ).toBeVisible();
    if (status === "STOPPED")
      await page.screenshot({
        path: info.outputPath("overview.png"),
        fullPage: true,
      });
    await page.locator("#operation-diagnostics > summary").click();
    await expect(page.getByText(/許容誤差：基軸通貨 0.000000001/)).toBeVisible();
    await page.locator(".operation-candidate summary").click();
    await expect(page.locator(".operation-candidate")).toContainText(
      "未評価（前段の条件未通過または処理中）",
    );
    await expect(page.locator(".operation-candidate")).toContainText(
      "手数料を払うと、十分に儲からないので見送りました",
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
test("narration survives polling, reconnects and stops without duplicates or unsafe poses", async ({
  page,
}, info) => {
  await page.clock.install();
  const api = await open(page, "RUNNING");
  await page.getByRole("button", { name: "実況", exact: true }).click();
  const feed = page.getByRole("region", {
    name: "エージェント実況",
    exact: true,
  });
  // The character's pose hook (pose-* class) lives on the header
  // avatar now; the in-feed stage was removed.
  const avatar = page.locator(".agent-avatar");
  const operations = (await page.evaluate(async () =>
    (await fetch("/api/operations")).json(),
  )) as OperationsSnapshot;
  let fail = false;
  await page.route("**/api/operations", (route) =>
    fail ? route.abort() : route.fulfill({ json: operations }),
  );
  const stamp = await page.evaluate(() => Date.now());
  operations.candidates = [
    {
      ...operations.candidates[0],
      id: "pending-to-filled",
      finalAction: "PENDING",
      timestamp: stamp,
    },
  ];
  await page.clock.runFor(10_000);
  const count = await feed.locator(".agent-feed-entry").count();
  operations.candidates[0].finalAction = "BUY";
  operations.candidates[0].timestamp = stamp + 20_000;
  operations.lastHeartbeatAt = stamp + 20_000;
  await page.clock.runFor(10_000);
  await expect(feed.locator(".agent-feed-entry.trade")).toHaveCount(1);
  await expect(avatar).toHaveClass(/pose-pointSmile/);
  await expect(feed.locator(".agent-feed-entry")).toHaveCount(count + 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(avatar.locator("img")).toHaveCSS("animation-name", "none");
  fail = true;
  await page.clock.runFor(10_000);
  await expect(avatar).toHaveClass(/pose-normal/);
  fail = false;
  operations.lastHeartbeatAt = stamp + 40_000;
  await page.clock.runFor(10_000);
  await expect(feed.locator(".agent-feed-entry.trade")).toHaveCount(1);
  operations.status = "STOPPED";
  operations.safety.botState = "MANUAL_STOP";
  await page.clock.runFor(10_000);
  await expect(avatar).toHaveClass(/pose-sleep/);
  operations.status = "ABNORMAL_STOP";
  operations.stopReason = "PAPER_RECONCILIATION_FAILED";
  operations.safety.botState = "ABNORMAL_STOP";
  await page.clock.runFor(10_000);
  await expect(avatar).toHaveClass(/pose-sleep/);
  await expect(feed.locator(".agent-feed-entry").first()).toContainText(
    "止まったよ",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(api.writes).toEqual([]);
  await feed.screenshot({ path: info.outputPath("narration-stopped.png") });
});

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
  await expect(page.locator(".operation-hero")).toContainText(
    "最新のBot状態を取得できません",
  );
  await expect(page.locator(".operation-hero.healthy")).toHaveCount(0);
  expect(api.writes).toEqual([]);
});

test("shows Japanese rate-limit monitoring and keeps recovery separate from restart", async ({
  page,
}) => {
  const api = await open(page, "ABNORMAL_STOP", true);
  await page.locator("#operation-diagnostics > summary").click();
  await expect(
    page.getByText(
      "APIの利用制限に達しました。安全のためPAPER取引を停止しています。再試行可能時刻を確認してください。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/再試行待機解除後も自動再開しません/),
  ).toBeVisible();
  const card = page.locator("article").filter({
    has: page.getByRole("heading", { name: "GeckoTerminal", exact: true }),
  });
  await expect(card).toContainText("再試行待機中");
  await expect(card).toContainText("再試行：1回");
  await expect(card).toContainText("429：2件");
  expect(api.writes).toEqual([]);
});

test("shows sanitized network failure diagnostics without mobile overflow", async ({
  page,
}) => {
  await open(page, "ABNORMAL_STOP", false, true);
  await page.locator("#operation-diagnostics > summary").click();
  const card = page.locator("article").filter({
    has: page.getByRole("heading", { name: "GeckoTerminal", exact: true }),
  });
  await expect(card).toContainText("名前解決に失敗しました");
  await expect(card).toContainText("5分足取得");
  await expect(card).toContainText("EAI_AGAIN");
  await expect(card).toContainText("42ms");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("times out delayed operations and ignores a late response after a newer success", async ({
  page,
}) => {
  await page.clock.install();
  await open(page, "STOPPED");
  const snapshot = await page.evaluate(async () =>
    (await fetch("/api/operations")).json(),
  );
  let release: (() => Promise<void>) | undefined;
  let calls = 0;
  await page.route("**/api/operations", async (route) => {
    calls++;
    if (calls === 1) {
      await new Promise<void>((resolve) => {
        release = async () => {
          await route.fulfill({
            json: {
              ...snapshot,
              status: "ABNORMAL_STOP",
              stopReason: "EMERGENCY_STOP",
            },
          });
          resolve();
        };
      });
    } else await route.fulfill({ json: snapshot });
  });
  await page.clock.runFor(10000);
  await expect.poll(() => calls).toBe(1);
  await page.clock.runFor(8100);
  await expect(page.locator(".operation-hero")).toContainText(
    "最新のBot状態を取得できません",
  );
  await page.clock.runFor(2000);
  await expect(page.locator(".operation-hero")).toHaveClass(/stopped/);
  await expect(page.locator(".operation-hero")).toContainText(
    "Botは停止しています",
  );
  await release!();
  await expect(page.locator(".operation-hero")).toHaveClass(/stopped/);
});

test("vital animation follows errors, recovery, stop and reduced motion", async ({
  page,
}) => {
  await page.clock.install();
  const api = await open(page, "RUNNING");
  const vital = page.locator(".bot-vital");
  await expect(vital).toHaveClass("bot-vital alive");
  await expect(vital).toContainText("高さ・色は装飾");
  await expect(page.locator(".bot-vital-drop")).toHaveCSS(
    "animation-name",
    "bot-drop-fall",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".bot-vital-drop")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const snapshot = await page.evaluate(async () =>
    (await fetch("/api/operations")).json(),
  );
  let status = "DEGRADED";
  let fetchElapsedMs = 0;
  await page.route("**/api/operations", async (route) =>
    route.fulfill({
      json: {
        ...snapshot,
        timing: {
          ...snapshot.timing,
          fetching: fetchElapsedMs > 0,
          fetchElapsedMs,
          lastTransportSuccessAt: await page.evaluate(() => Date.now()),
        },
        lastMarketClosedAt: await page.evaluate(() => Date.now() - 300_000),
        lastHeartbeatAt: await page.evaluate(() => Date.now()),
        status: status === "STOPPED" ? "STOPPED" : "RUNNING",
        safety: {
          ...snapshot.safety,
          connectivity: status === "STOPPED" ? "HEALTHY" : status,
          botState: status === "STOPPED" ? "MANUAL_STOP" : "RUNNING",
        },
      },
    }),
  );
  await page.clock.runFor(10_000);
  await expect(vital).toHaveClass("bot-vital weak");
  status = "HEALTHY";
  await page.clock.runFor(10_000);
  await expect(vital).toHaveClass("bot-vital alive");
  status = "STOPPED";
  await page.clock.runFor(10_000);
  await expect(vital).toHaveClass("bot-vital sleeping");
  await expect(page.locator(".bot-vital-drop")).toHaveCount(0);
  status = "HEALTHY";
  await page.clock.runFor(10_000);
  await expect(vital).toHaveClass("bot-vital alive");
  fetchElapsedMs = 45_001;
  await page.clock.runFor(10_000);
  await expect(vital).toHaveClass("bot-vital unknown");
  await expect(page.locator(".operation-hero")).toContainText(
    "最新のBot状態を取得できません",
  );
  fetchElapsedMs = 0;
  await page.clock.runFor(10_000);
  await expect(vital).toHaveClass("bot-vital alive");
  expect(api.writes).toEqual([]);
  await page.locator(".operation-hero").screenshot({
    path: `test-results/vital-${test.info().project.name}.png`,
  });
});

test("vital expires immediately on page return and after API timeout", async ({
  page,
}) => {
  await page.clock.install();
  await open(page, "RUNNING");
  const vital = page.locator(".bot-vital");
  await expect(vital).toHaveClass("bot-vital alive");
  await page.clock.setSystemTime(Date.now() + 60_000);
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expect(vital).toHaveClass("bot-vital unknown");
  await expect(page.locator(".bot-vital-drop")).toHaveCount(0);
  await page.route("**/api/operations", () => {});
  await page.clock.runFor(18_100);
  await expect(page.locator(".operation-hero")).toContainText(
    "最新のBot状態を取得できません",
  );
  await expect(vital).toHaveClass("bot-vital unknown");
});
