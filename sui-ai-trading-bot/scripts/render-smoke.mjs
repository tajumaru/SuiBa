/**
 * Render smoke: serve the built dashboard and open it in a real
 * Chromium, asserting the app actually mounts and its styles
 * actually apply. Unit tests and the production build both
 * stayed green the day a CSS brace accident killed every rule
 * after a point in one segment file and the device UI died —
 * only a real render catches that class.
 *
 * Probes span the cascade: :root (base.css, first segment),
 * .login-brand (login.css), .version-footer (extras.css, LAST
 * segment — the one the accident emptied). The API is not
 * stubbed: /api/* falls back to index.html, the session check
 * fails closed, and the app must land on the login screen.
 *
 * Run after `pnpm build`:  node scripts/render-smoke.mjs
 * (CI installs the browser first: playwright install --with-deps chromium)
 */
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../apps/dashboard/dist", import.meta.url));
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  let body, type;
  try {
    let path = decodeURIComponent(new URL(req.url, "http://smoke").pathname);
    if (path === "/") path = "/index.html";
    const file = normalize(join(dist, path));
    if (!file.startsWith(dist)) throw new Error("bad path");
    body = await readFile(file);
    type = MIME[extname(file)] ?? "application/octet-stream";
  } catch {
    body = await readFile(join(dist, "index.html"));
    type = "text/html";
  }
  res.writeHead(200, { "content-type": type });
  res.end(body);
});
await new Promise((resolve) =>
  server.listen(
    Number(process.env.RENDER_SMOKE_PORT ?? 0),
    "127.0.0.1",
    resolve,
  ),
);
const port = server.address().port;

const failures = [];
let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => failures.push(`pageerror: ${e.message}`));
  await page
    .goto(`http://127.0.0.1:${port}/`, { waitUntil: "load", timeout: 30000 })
    .catch((e) => failures.push(`goto: ${e.message}`));
  await page
    .waitForSelector(".login-brand", { timeout: 15000 })
    .catch(() =>
      failures.push("login screen did not render (.login-brand missing)"),
    );
  /* eslint-disable no-undef -- the callback below runs in the page */
  const probe = await page.evaluate(() => {
    const style = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el) : null;
    };
    const root = document.getElementById("root");
    return {
      rootChildren: root ? root.childElementCount : 0,
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      brandText: document.querySelector(".login-brand")?.textContent ?? "",
      brandColor: style(".login-brand")?.color ?? null,
      footerText: document.querySelector(".version-footer")?.textContent ?? "",
      footerColor: style(".version-footer")?.color ?? null,
    };
  });
  /* eslint-enable no-undef */
  if (probe.rootChildren === 0)
    failures.push("app did not mount (#root is empty)");
  if (probe.htmlBg !== "rgb(11, 17, 27)")
    failures.push(`base.css not applied (:root background = ${probe.htmlBg})`);
  if (!probe.brandText.includes("POTARIO"))
    failures.push("login brand text missing");
  if (probe.brandColor !== "rgb(67, 223, 178)")
    failures.push(
      `login.css not applied (.login-brand color = ${probe.brandColor})`,
    );
  if (!probe.footerText.includes("Built on Sui"))
    failures.push("version footer missing");
  if (probe.footerColor !== "rgb(143, 163, 176)")
    failures.push(
      `extras.css not applied (.version-footer color = ${probe.footerColor})`,
    );
  await page.screenshot({ path: "render-smoke.png" }).catch(() => undefined);
  console.log("render smoke probe:", JSON.stringify(probe));
  // Offline authenticated shell: exercise the five-tab navigation and relocated
  // evidence without contacting any worker or writing a production database.
  const fixture = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { dashboardPreviewFixture } from "./scripts/dashboard-preview-fixture.ts"; process.stdout.write(JSON.stringify(dashboardPreviewFixture({ equityRoundTrip: true })));',
      ],
      { encoding: "utf8" },
    ),
  );
  fixture.operations.safety.lastStopReason = "UPSTREAM_HTTP_500";
  fixture.state.party = {
    hero: { count: 23, level: 3, remaining: 7, progress: 8 / 15 },
    forecast: { count: 287, level: 3, remaining: 13, progress: 137 / 150 },
    shield: { count: 0, level: 1, remaining: 5, progress: 0 },
    shadow: { count: 50, level: 2, remaining: 100, progress: 0 },
    healer: { count: 21, level: 5, remaining: 19, progress: 1 / 20 },
    sage: { count: 0, level: 999, remaining: null, progress: 1 },
  };
  fixture.state.chain = {
    epoch: 1024,
    checkpoint: 182394551,
    tps: 1208,
    gasMist: 1000,
    epochStartMs: Date.now() - 3600000,
    epochDurationMs: 86400000,
    validators: 108,
    at: Date.now(),
  };
  fixture.operations.reports.find(
    (report) => report.hours === 168,
  ).stopReasons = [
    { timestamp: Date.now() - 90000, reason: "PROCESS_RESTART_STOPPED" },
    { timestamp: Date.now() - 60000, reason: "UPSTREAM_HTTP_429" },
    { timestamp: Date.now() - 30000, reason: "UPSTREAM_HTTP_500" },
  ];
  const commands = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session")
      return route.fulfill({ json: { authenticated: true } });
    if (path === "/api/state") return route.fulfill({ json: fixture.state });
    if (path === "/api/operations")
      return route.fulfill({ json: fixture.operations });
    if (path === "/api/control") {
      const { command } = route.request().postDataJSON();
      commands.push(command);
      fixture.state.runtime.running = command === "start";
      return route.fulfill({ json: fixture.state.runtime });
    }
    return route.fulfill({ status: 404, json: { error: "NOT_FOUND" } });
  });
  await page.reload();
  await page.locator(".boot-screen").waitFor({ state: "hidden" });
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const buttons = page.locator("nav button[aria-label]");
    if ((await buttons.count()) !== 4)
      failures.push(`${width}px: expected four tabs`);
    // The EPOCH/TPS readout and the always-on Worker panel were
    // retired on 2026-11-22 (owner call): the overview stays
    // silent while the worker is healthy, so there is no chain
    // strip left to probe here. The Sui credit lives in the
    // version footer.
    const suiCredit = page.locator(".version-footer").getByRole("link", {
      name: "Sui",
    });
    // Since 2026-11-21 the party panel lives in the strategy
    // tab's パーティ segment, not on the overview tab. The
    // segment switch is dispatched as a DOM click: on later
    // viewport passes the tab can sit under a fixed bar after
    // auto-scroll and a real pointer click never lands (the
    // switching logic itself is covered by unit tests).
    await page.getByRole("button", { name: "戦略", exact: true }).click();
    await page
      .locator("#strategy-segment-party")
      .evaluate((el) => el.click());
    const party = page.getByRole("region", { name: "パーティ" });
    await party.waitFor();
    if ((await party.getByRole("progressbar").count()) !== 6 ||
        !(await party.getByText("毎朝の振り返り担当").isVisible()) ||
        !(await party.getByText("次のレベルまで あと13件").isVisible()) ||
        !(await party.evaluate((section) => section.scrollWidth <= section.clientWidth)))
      failures.push(`${width}px: party rows, progress bars or layout missing`);
    await page
      .getByRole("button", { name: "ダッシュボード", exact: true })
      .click();
    const creditLogo = suiCredit.locator("img");
    if (
      (await suiCredit.getAttribute("href")) !== "https://sui.io" ||
      (await creditLogo.getAttribute("src")) !== "/sui-logo.svg"
    )
      failures.push(`${width}px: Sui footer credit link or logo is missing`);
    if ((await page.getByRole("link", { name: "Walrus" }).count()) !== 0)
      failures.push(`${width}px: Walrus credit should be retired`);
    for (const name of [
      "実況",
      "ダッシュボード",
      "戦略",
      "取引履歴",
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page
        .getByRole("button", { name, exact: true })
        .and(page.locator(".active"))
        .waitFor();
    }
    await page
      .getByRole("button", { name: "ダッシュボード", exact: true })
      .click();
    const curve = page.getByRole("region", { name: "資産の推移" });
    await curve.waitFor();
    for (const range of ["24時間", "7日", "30日"]) {
      await curve.getByRole("button", { name: range, exact: true }).click();
      const text = await curve.textContent();
      if (
        !text.includes("取引（確定） -0.81 USDC") ||
        !text.includes("保有中の値動き 0.00 USDC")
      )
        failures.push(
          `${width}px/${range}: cash-only round-trip attribution missing`,
        );
    }
    await curve.getByRole("button", { name: "7日", exact: true }).click();
    await page.screenshot({ path: `render-smoke-overview-${width}.png` });
    await page.getByRole("button", { name: "取引履歴", exact: true }).click();
    await page.getByRole("region", { name: "過去の停止理由" }).waitFor();
    /* eslint-disable no-undef -- computed styles run inside Chromium */
    const historyType = await page
      .locator(".stop-history")
      .evaluate((card) => ({
        heading: getComputedStyle(card.querySelector("h3")).fontSize,
        timestamp: getComputedStyle(card.querySelector("time")).fontSize,
        reason: getComputedStyle(card.querySelector("li strong")).fontSize,
        weight: getComputedStyle(card.querySelector("li strong")).fontWeight,
        fits: card.scrollWidth <= card.clientWidth,
      }));
    /* eslint-enable no-undef */
    if (
      historyType.heading !== "15px" ||
      historyType.timestamp !== "12px" ||
      historyType.reason !== "13px" ||
      Number(historyType.weight) < 600 ||
      !historyType.fits
    )
      failures.push(`${width}px: stop history hierarchy regressed`);
    await page.screenshot({ path: `render-smoke-history-${width}.png` });
    /* eslint-disable no-undef -- runs inside Chromium */
    if (
      !(await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ))
    )
      failures.push(`${width}px: horizontal overflow`);
    /* eslint-enable no-undef */
  }
  fixture.state.indicators = { ...fixture.state.indicators, rsi: 25 };
  await page.reload();
  await page.locator(".rsi-gauge").waitFor();
  fixture.state.boss = {
    startedAt: Date.now(),
    type: "lightning",
    name: "大・閃光の投げ売り",
    strength: "大",
    drop: 0.05,
    windowSeconds: 3600,
    high: 1,
    low: 0.95,
    startingEquity: fixture.state.equity,
    recovery: 0.25,
    turn: "boss",
    latestEvent: null,
    retreatReason: null,
    outcome: null,
  };
  await page.reload();
  const bossCard = page.getByRole("button", { name: /大・閃光の投げ売り/ });
  const battle = page.getByRole("region", { name: "ボス戦" });
  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await bossCard.click();
    await battle.waitFor();
    if (
      (await page.locator(".rsi-gauge").count()) !== 0 ||
      !(await battle.getByText("Lv. 3").isVisible()) ||
      !(await battle.getByText("無傷（ポジションなし）").isVisible()) ||
      (await battle.getByRole("progressbar", { name: "ポタリオのHP" }).getAttribute("aria-valuenow")) !== "100" ||
      !(await battle.evaluate((sheet) => sheet.scrollWidth <= sheet.clientWidth))
    )
      failures.push(`${width}px: battle scene or card layout regressed`);
    await battle.getByRole("button", { name: "閉じる", exact: true }).click();
    await battle.waitFor({ state: "hidden" });
  }
  await bossCard.click();
  await page
    .getByRole("button", { name: "PAPER運用開始", exact: true })
    .click();
  await page
    .getByRole("button", { name: "PAPER運用停止", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "PAPER運用停止", exact: true })
    .click();
  await page
    .getByRole("button", { name: "PAPER運用開始", exact: true })
    .waitFor();
  if (commands.join(",") !== "start,stop")
    failures.push("header control commands changed");
  fixture.state.boss.outcome = { at: Date.now(), result: "endured" };
  await page.reload();
  await page.locator(".rsi-gauge").waitFor();
  if ((await bossCard.count()) || (await battle.count()))
    failures.push("finished battle still has a card or scene");
  // Populated monthly report: the longest labels must remain on one line.
  fixture.state.trades = [0.17, -0.24].map((pnl, i) => ({
    orderId: `monthly-smoke-${i}`,
    side: "SELL",
    timestamp: Date.now(),
    quantity: 1,
    price: 2,
    fee: 0.01,
    pnl,
    slippage: 0,
    priceImpact: 0,
  }));
  await page.reload();
  await page.locator(".boot-screen").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "ダッシュボード", exact: true })
    .click();
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const monthly = page.getByRole("region", { name: "月報", exact: true });
    await monthly.scrollIntoViewIfNeeded();
    await monthly.getByText("一番の勝ち", { exact: true }).waitFor();
    /* eslint-disable no-undef -- runs inside Chromium */
    const layout = await monthly.evaluate((card) => ({
      labelsFit: [...card.querySelectorAll("dt")].every((label) => {
        const text = document.createRange();
        text.selectNodeContents(label);
        return text.getClientRects().length === 1;
      }),
      fits: card.scrollWidth <= card.clientWidth,
      rowLineHeight: getComputedStyle(
        card.querySelector(".monthly-report-rows"),
      ).lineHeight,
    }));
    /* eslint-enable no-undef */
    if (!layout.labelsFit || !layout.fits || layout.rowLineHeight !== "20px")
      failures.push(
        `${width}px: monthly report layout ${JSON.stringify(layout)}`,
      );
    await page.screenshot({ path: `render-smoke-monthly-${width}.png` });
  }
  const header = page.locator("header").filter({ hasText: "Potario" });
  // PAPER shows no network badge: the worker's network is only the
  // market-data source there, and a MAINNET badge reads as real trading.
  if (await header.getByText("MAINNET", { exact: true }).count())
    failures.push("PAPER shows a network badge");
  if (await header.getByText("TESTNET", { exact: true }).count())
    failures.push("PAPER shows a network badge");
  const headerBackground = () =>
    // eslint-disable-next-line no-undef -- runs inside Chromium
    header.evaluate((el) => getComputedStyle(el).backgroundColor);
  const reloadOverview = async () => {
    await page.reload();
    await page.locator(".boot-screen").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "ダッシュボード", exact: true }).click();
  };
  const paperBackground = await headerBackground();
  // The mix and the cumulative PnL share one 資産 card since
  // 2026-11-22 (owner: one card, not two stacked panels).
  const assets = page.getByRole("region", { name: "資産", exact: true });
  fixture.state.price = 2;
  await reloadOverview();
  await assets.getByText("99.19（現金）", { exact: false }).waitFor();
  await page.getByText("累計損益", { exact: true }).waitFor();
  await page.getByText("資産の推移", { exact: true }).waitFor();

  fixture.state.mode = "REAL";
  fixture.state.network = "testnet";
  fixture.state.realBalances = { SUI: 3, DBUSDC: 12, DEEP: 22 };
  await reloadOverview();
  const testnet = header.getByText("TESTNET", { exact: true });
  const realBadge = header.getByText("REAL（実売買）", { exact: true });
  // REAL keeps its own 資産の中身 region (BalanceManager balances);
  // only the PAPER mix merged into the 資産 card.
  const realAssets = page.getByRole("region", { name: "資産の中身", exact: true });
  await realAssets.getByText("≈ 18.00 DBUSDC", { exact: true }).waitFor();
  await realAssets.getByText("DEEP 22", { exact: true }).waitFor();
  if (await page.getByText("累計損益", { exact: true }).count())
    failures.push("REAL shows PAPER cumulative PnL");
  if (await page.getByText("資産の推移", { exact: true }).count())
    failures.push("REAL shows PAPER asset history");
  if ((await headerBackground()) === paperBackground)
    failures.push("TESTNET header background matches PAPER");
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const [envBox, modeBox] = await Promise.all([
      testnet.boundingBox(),
      realBadge.boundingBox(),
    ]);
    if (!envBox || !modeBox || modeBox.x + modeBox.width > envBox.x ||
        envBox.x + envBox.width > width)
      failures.push(`${width}px: network and trading mode badges do not fit`);
  }
  delete fixture.state.realBalances;
  await reloadOverview();
  await realAssets.getByText("残高を確認できません", { exact: true }).waitFor();
  if (await realAssets.getByText("99.19", { exact: false }).count())
    failures.push("REAL with unavailable balances shows PAPER cash");
  console.log(
    `five-tab render: 320/375/1280px, header start/stop passed on loopback port ${port}`,
  );
} catch (e) {
  failures.push(`smoke crashed: ${e instanceof Error ? e.message : e}`);
} finally {
  await browser?.close().catch(() => undefined);
  server.close();
}
if (failures.length) {
  console.error(
    "RENDER SMOKE FAILED:\n" + failures.map((f) => `- ${f}`).join("\n"),
  );
  process.exit(1);
}
console.log("render smoke ok");
