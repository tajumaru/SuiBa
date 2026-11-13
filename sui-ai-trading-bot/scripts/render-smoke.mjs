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
  if (!probe.footerText.includes("Potario"))
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
        'import { dashboardPreviewFixture } from "./scripts/dashboard-preview-fixture.ts"; process.stdout.write(JSON.stringify(dashboardPreviewFixture()));',
      ],
      { encoding: "utf8" },
    ),
  );
  fixture.operations.safety.lastStopReason = "UPSTREAM_HTTP_500";
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
    if ((await buttons.count()) !== 5)
      failures.push(`${width}px: expected five tabs`);
    for (const name of [
      "実況",
      "ダッシュボード",
      "戦略",
      "取引履歴",
      "バックテスト比較",
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
    await page.getByRole("region", { name: "Workerの状態" }).waitFor();
    if (
      !(
        await page.getByRole("region", { name: "Workerの状態" }).textContent()
      ).includes("最終分析成功")
    )
      failures.push("analysis evidence missing");
    /* eslint-disable no-undef -- computed typography runs inside Chromium */
    const workerType = await page
      .locator(".worker-freshness")
      .evaluate((card) => ({
        heading: getComputedStyle(card.querySelector("h3")).fontSize,
        body: getComputedStyle(card.querySelector("dd")).fontSize,
        status: getComputedStyle(card.querySelector("p")).fontSize,
      }));
    /* eslint-enable no-undef */
    if (
      workerType.heading !== "15px" ||
      workerType.body !== "13px" ||
      workerType.status !== "13px"
    )
      failures.push(
        `${width}px: Worker typography differs from the overview scale`,
      );
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
