// Docker Compose integration verification. All volumes are NEW and retained.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
const suffix = randomBytes(6).toString("hex");
const project = `suiba-compose-verify-${suffix}`;
const requestedImage = process.argv
  .slice(2)
  .find((arg) => !arg.startsWith("--"));
const browserCheck = process.argv.includes("--browser");
const image = requestedImage ?? `suiba-compose-verify:${suffix}`;
const token = randomBytes(32).toString("hex");
const folder = mkdtempSync(join(tmpdir(), "suiba-compose-verify-"));
const override = join(folder, "override.yaml");
const env = { ...process.env, SUIBA_VERIFY_TOKEN: token };
const options = {
  encoding: "utf8",
  windowsHide: true,
  env,
  stdio: ["ignore", "pipe", "pipe"],
};
const docker = (...args) => execFileSync("docker", args, options).trim();
const compose = (...args) =>
  docker(
    "compose",
    "-p",
    project,
    "-f",
    resolve("docker/compose.yaml"),
    "-f",
    override,
    ...args,
  );
let stage = "initialization",
  cid,
  volume;
const mark = (value) => {
  stage = value;
  console.log(value);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ready() {
  cid = compose("ps", "-q", "bot");
  assert.ok(cid);
  const address = compose("port", "bot", "3100");
  const base = `http://${address}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/healthz`, {
        signal: AbortSignal.timeout(1500),
      });
      if (r.ok) return base;
    } catch {}
    await sleep(1000);
  }
  throw new Error("CONTAINER_NOT_READY");
}
async function api(base, path, body) {
  const r = await fetch(`${base}/api/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(r.status, 200);
  return r.json();
}
function node(code) {
  return docker(
    "exec",
    cid,
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    code,
  );
}
try {
  writeFileSync(
    override,
    `services:\n  bot:\n    image: ${image}\n    env_file: !reset []\n    environment:\n      ADMIN_TOKEN: \${SUIBA_VERIFY_TOKEN}\n      SUI_GRPC_URL: https://127.0.0.1:1\n    ports: !override\n      - '127.0.0.1::3100'\n`,
  );
  docker("version");
  if (!requestedImage) {
    mark("Building Linux image");
    docker("build", "-f", "docker/Dockerfile", "-t", image, ".");
  }
  mark("Checking actual Compose configuration and starting isolated service");
  compose("config", "--quiet");
  compose("up", "-d", "--no-build");
  let base = await ready();
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  const html = await (await fetch(base)).text();
  assert.match(html, /<html/);
  const asset = html.match(/src="([^"]+\.js)"/);
  assert.ok(asset);
  assert.equal((await fetch(new URL(asset[1], base))).status, 200);
  let state = await api(base, "state");
  assert.equal(state.mode, "PAPER");
  assert.equal(state.runtime.running, false);
  const config = JSON.parse(
    docker(
      "inspect",
      "--format",
      '{"user":"{{.Config.User}}","init":{{.HostConfig.Init}},"logs":{{json .HostConfig.LogConfig}},"mounts":{{json .Mounts}},"ports":{{json .NetworkSettings.Ports}},"restart":"{{.HostConfig.RestartPolicy.Name}}","stopTimeout":{{.Config.StopTimeout}}}',
      cid,
    ),
  );
  assert.equal(config.user, "node");
  assert.equal(config.init, true);
  assert.equal(config.logs.Type, "json-file");
  assert.equal(config.logs.Config["max-size"], "10m");
  assert.equal(config.logs.Config["max-file"], "3");
  assert.equal(config.ports["3100/tcp"][0].HostIp, "127.0.0.1");
  assert.equal(config.restart, "unless-stopped");
  assert.equal(config.stopTimeout, 30);
  volume = config.mounts.find((m) => m.Destination === "/app/data")?.Name;
  assert.equal(volume, `${project}_paper-data`);
  node(
    `import assert from 'node:assert/strict'; import { existsSync } from 'node:fs'; import { DatabaseSync } from 'node:sqlite'; assert.notEqual(process.getuid(), 0); assert.equal(existsSync('/app/.env'),false); assert.ok(existsSync('/app/data/bot.sqlite-wal')); assert.ok(existsSync('/app/data/bot.sqlite-shm')); const d=new DatabaseSync('/app/data/bot.sqlite'); assert.equal(d.prepare('PRAGMA journal_mode').get().journal_mode,'wal'); d.close();`,
  );
  const settings = { ...state.settings, maxOrder: 4 };
  await api(base, "settings", settings);
  mark("Checking SIGTERM graceful stop, backup and retained settings");
  node(
    `import { BotDatabase } from './packages/database/src/index.ts'; const db=new BotDatabase('/app/data/bot.sqlite'); db.append('risk_events','compose-retention',{timestamp:1,reasons:['COMPOSE_RETENTION_TEST']},1); db.set('runtime',{...db.runtime(),running:true,error:null}); db.close();`,
  );
  compose("stop", "--timeout", "30", "bot");
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", cid), "0");
  compose("cp", "bot:/app/data/.", folder);
  assert.ok(existsSync(join(folder, "bot.sqlite")));
  const stopped = JSON.parse(
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "--mount",
      `type=volume,source=${volume},target=/app/data`,
      image,
      "node",
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/app/data/bot.sqlite',{readOnly:true}); const r=JSON.parse(db.prepare('SELECT json FROM bot_runtime_state WHERE key=?').get('runtime').json); console.log(JSON.stringify(r)); db.close();`,
    ),
  );
  assert.equal(stopped.running, false);
  compose("start", "bot");
  base = await ready();
  state = await api(base, "state");
  assert.equal(state.runtime.running, false);
  assert.equal(state.settings.maxOrder, 4);
  mark("Checking abrupt termination, emergency stop and container recreation");
  node(
    `import { BotDatabase } from './packages/database/src/index.ts'; const db=new BotDatabase('/app/data/bot.sqlite'); db.set('runtime',{...db.runtime(),running:true,emergency:false,error:null}); db.close();`,
  );
  compose("kill", "-s", "SIGKILL", "bot");
  compose("up", "-d", "--no-build");
  base = await ready();
  state = await api(base, "state");
  assert.equal(state.runtime.running, false);
  assert.equal(state.runtime.emergency, false);
  await api(base, "control", { command: "emergency" });
  compose("kill", "-s", "SIGKILL", "bot");
  compose("up", "-d", "--no-build");
  base = await ready();
  state = await api(base, "state");
  assert.equal(state.runtime.running, false);
  assert.equal(state.runtime.emergency, true);
  const previous = cid;
  compose("up", "-d", "--no-build", "--force-recreate");
  base = await ready();
  assert.notEqual(cid, previous);
  state = await api(base, "state");
  assert.equal(state.runtime.running, false);
  assert.equal(state.runtime.emergency, true);
  assert.equal(state.settings.maxOrder, 4);
  assert.ok(
    state.riskEvents.some((e) => e.reasons?.includes("COMPOSE_RETENTION_TEST")),
  );
  mark("Waiting for Docker-declared health status");
  let health;
  for (let i = 0; i < 45; i++) {
    health = docker("inspect", "--format", "{{.State.Health.Status}}", cid);
    if (health === "healthy") break;
    await sleep(1000);
  }
  assert.equal(health, "healthy");
  mark(
    "Running complete unit/integration regression suite inside Linux container",
  );
  docker("cp", "tests", `${cid}:/app/tests`);
  docker("cp", "docs", `${cid}:/app/docs`);
  const tests = docker(
    "exec",
    cid,
    "node",
    "node_modules/vitest/vitest.mjs",
    "run",
    "--no-cache",
  );
  console.log(tests.replace(/\u001b\[[0-9;]*m/g, ""));
  if (browserCheck) {
    mark("Checking the real container dashboard with Chromium");
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(base);
      await page.getByLabel("管理トークン").fill(token);
      await page.getByRole("button", { name: "接続", exact: true }).click();
      await page.getByRole("button", { name: "運用検証", exact: true }).click();
      await page
        .getByRole("heading", { name: "運用検証", exact: true, level: 2 })
        .waitFor();
      assert.match(
        await page.locator(".operation-state").innerText(),
        /異常停止/,
      );
      await page
        .getByRole("heading", { name: "外部API接続（このプロセスの集計）" })
        .waitFor();
      assert.equal(
        await page
          .getByRole("heading", { name: "Sui gRPC", exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "GeckoTerminal", exact: true })
          .count(),
        1,
      );
      assert.equal(
        await page.getByRole("heading", { name: "Cetus", exact: true }).count(),
        1,
      );
      assert.deepEqual(errors, []);
      mkdirSync("test-results", { recursive: true });
      await page.screenshot({
        path: "test-results/docker-compose-dashboard.png",
        fullPage: true,
      });
      console.log(
        "PASS: Chromium authenticated dashboard and Japanese API monitoring; no page errors.",
      );
    } finally {
      await browser.close();
    }
  }
  mark("Checking LIVE startup rejection without a volume");
  const live = spawnSync(
    "docker",
    ["run", "--rm", "--network", "none", "-e", "MODE=LIVE", image],
    options,
  );
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /ONLY_PAPER_SUPPORTED/);
  mark("Checking SQLite transaction rollback under constrained tmpfs capacity");
  docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--tmpfs",
    "/app/limited:rw,size=1m,uid=1000,gid=1000",
    image,
    "node",
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict'; import { DatabaseSync } from 'node:sqlite'; const d=new DatabaseSync('/app/limited/full.sqlite'); d.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE records(value BLOB); INSERT INTO records VALUES('retained')"); let full=false; try {d.exec('BEGIN'); for(let i=0;i<100;i++) d.prepare('INSERT INTO records VALUES(randomblob(65536))').run(); d.exec('COMMIT');} catch(e){assert.match(e.message,/database or disk is full/); full=true; try{d.exec('ROLLBACK');}catch{}} assert.ok(full); assert.equal(d.prepare('SELECT count(*) AS n FROM records').get().n,1); assert.equal(Object.values(d.prepare('PRAGMA integrity_check').get())[0],'ok'); d.close();`,
  );
  mark("Checking Worker fails closed when its data disk is already full");
  const full = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--tmpfs",
      "/app/data:rw,size=1m,uid=1000,gid=1000",
      "-e",
      "MODE=PAPER",
      "-e",
      `ADMIN_TOKEN=${token}`,
      image,
      "node",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { writeFileSync } from 'node:fs'; writeFileSync('/app/data/fill',Buffer.alloc(1024*1024)); await import('./apps/worker/src/index.ts');`,
    ],
    options,
  );
  assert.notEqual(full.status, 0);
  assert.match(full.stderr, /disk is full|SQLITE|sqlite|disk I\/O/);
  assert.ok(!compose("logs", "--no-color", "bot").includes(token));
  console.log(
    "PASS: Compose build/start/health, dashboard, authentication, WAL, SIGTERM, backup, abrupt restart, emergency/settings/history retention, Linux regressions, LIVE rejection and disk-full safety.",
  );
} catch {
  // Never print exec exceptions: command arguments may contain an ephemeral token.
  console.error(`FAIL at stage: ${stage}`);
  process.exitCode = 1;
} finally {
  try {
    compose("stop", "--timeout", "30", "bot");
    compose("rm", "-f", "bot");
  } catch {}
  const cleanupPath = resolve(folder);
  assert.equal(dirname(cleanupPath), resolve(tmpdir()));
  assert.ok(basename(cleanupPath).startsWith("suiba-compose-verify-"));
  rmSync(cleanupPath, { recursive: true, force: true });
  console.log(`Verification project: ${project}`);
  console.log(
    `Verification volume retained (if created): ${volume ?? `${project}_paper-data`}`,
  );
  console.log(`Verification image retained: ${image}`);
}
