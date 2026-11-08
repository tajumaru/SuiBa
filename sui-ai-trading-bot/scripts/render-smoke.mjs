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
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  await page
    .screenshot({ path: "render-smoke.png" })
    .catch(() => undefined);
  console.log("render smoke probe:", JSON.stringify(probe));
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
