// Isolated, bounded integration test. Never touches the user's validation project.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { randomBytes } from "node:crypto";
const suffix = randomBytes(6).toString("hex"),
  project = `suiba-deepbook-test-${suffix}`,
  image = process.argv[2] ?? `suiba-deepbook-test:${suffix}`;
const folder = mkdtempSync(join(tmpdir(), "suiba-deepbook-")),
  token = randomBytes(32).toString("hex"),
  secret = join(folder, "admin.txt"),
  env = join(folder, "test.env"),
  override = join(folder, "override.yaml");
const options = {
  encoding: "utf8",
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
};
const docker = (...args) => execFileSync("docker", args, options).trim();
const compose = (...args) =>
  docker(
    "compose",
    "-p",
    project,
    "--env-file",
    env,
    "-f",
    resolve("docker/compose.deepbook-24h.yaml"),
    "-f",
    override,
    ...args,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stage = "initialize",
  cid,
  base;
function mark(s) {
  stage = s;
  console.log(s);
}
async function ready() {
  cid = compose("ps", "-q", "bot");
  base = "http://" + compose("port", "bot", "3100");
  for (let i = 0; i < 60; i++) {
    try {
      if (
        (await fetch(base + "/healthz", { signal: AbortSignal.timeout(1500) }))
          .ok
      )
        return;
    } catch {}
    await sleep(500);
  }
  throw Error("CONTAINER_NOT_READY");
}
async function api(path, body) {
  const r = await fetch(base + "/api/" + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(r.status, 200, path);
  return r.json();
}
function node(script) {
  return compose(
    "exec",
    "-T",
    "bot",
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script,
  );
}
try {
  writeFileSync(secret, token, { mode: 0o600 });
  writeFileSync(env, "VALIDATION_PORT=3101\n");
  writeFileSync(
    override,
    `services:\n  bot:\n    image: ${image}\n    env_file: !reset []\n    environment:\n      SUI_GRPC_URL: https://127.0.0.1:1\n    ports: !override\n      - '127.0.0.1::3100'\nsecrets:\n  validation-admin:\n    file: '${secret.replaceAll("\\", "/")}'\n`,
  );
  docker("version");
  if (!process.argv[2]) {
    mark("Build Linux image");
    docker("build", "-f", "docker/Dockerfile", "-t", image, ".");
  }
  mark(
    "Validate separate Compose project, secrets, ports, volumes and profile",
  );
  compose("config", "--quiet");
  compose("up", "-d", "--no-build");
  await ready();
  const info = JSON.parse(
    docker("inspect", "--format", "{{json .Mounts}}", cid),
  );
  for (const [path, name] of [
    ["/app/validation", "validation-data"],
    ["/app/reports", "validation-reports"],
  ])
    assert.equal(
      info.find((x) => x.Destination === path)?.Name,
      `${project}_${name}`,
    );
  assert.ok(!info.some((x) => x.Destination === "/app/data"));
  const config = JSON.parse(
    docker("inspect", "--format", "{{json .Config.Env}}", cid),
  );
  for (const value of [
    "MODE=PAPER",
    "MARKET_DATA_PROVIDER=deepbook",
    "DEEPBOOK_RECONSTRUCT_CANDLES=verified",
    "DATABASE_PATH=/app/validation/deepbook-paper.sqlite",
  ])
    assert.ok(config.includes(value));
  assert.ok(!config.some((e) => e.includes(token)));
  assert.equal((await fetch(base + "/api/validation")).status, 401);
  assert.equal((await api("validation")).status, "未開始");
  const session = await api("validation/start", {});
  assert.equal(session.status, "検証途中");
  const second = await fetch(base + "/api/validation/start", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(second.status, 409);
  assert.equal((await api("state")).runtime.running, false);
  mark("Check persisted measurement, automatic reports, safe stop and WAL");
  await api("control", { command: "emergency" });
  node(
    `import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';import {BotDatabase} from './packages/database/src/index.ts';assert.ok(existsSync('/app/validation/deepbook-paper.sqlite-wal'));assert.ok(existsSync('/app/validation/deepbook-paper.sqlite-shm'));assert.equal(existsSync('/app/.env'),false);const db=new BotDatabase('/app/validation/deepbook-paper.sqlite');db.append('risk_events','retention',{reason:'RETAINED'},1);db.close();assert.equal(JSON.parse(readFileSync('/app/reports/latest.json','utf8')).status,'検証途中');assert.match(readFileSync('/app/reports/latest.md','utf8'),/検証途中/);`,
  );
  await sleep(16000);
  const before = await api("validation");
  assert.ok(before.sampleCount >= 2);
  compose("stop", "--timeout", "30", "bot");
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", cid), "0");
  compose("start", "bot");
  await ready();
  const state = await api("state"),
    after = await api("validation");
  assert.equal(state.runtime.running, false);
  assert.equal(state.runtime.emergency, true);
  assert.equal(after.session.id, session.session.id);
  assert.ok(after.sampleCount >= before.sampleCount);
  assert.equal(after.status, "検証途中");
  node(
    `import assert from 'node:assert/strict';import {BotDatabase} from './packages/database/src/index.ts';const db=new BotDatabase('/app/validation/deepbook-paper.sqlite');assert.ok(db.history('risk_events').some(x=>x.reason==='RETAINED'));assert.equal(db.history('paper_trades').length,0);db.close();`,
  );
  const md = await fetch(base + "/api/validation/report.md", {
    headers: { Authorization: "Bearer " + token },
  });
  assert.equal(md.status, 200);
  assert.match(await md.text(), /検証途中/);
  assert.ok(!compose("logs", "--no-color", "bot").includes(token));
  mark("Check LIVE rejection before startup without network or wallets");
  const live = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-e",
      "MODE=LIVE",
      "-e",
      "DEEPBOOK_VALIDATION=1",
      image,
    ],
    options,
  );
  assert.notEqual(live.status, 0);
  assert.match(live.stdout + live.stderr, /ONLY_PAPER_SUPPORTED/);
  console.log(
    "PASS: isolated profile, secret auth, persistent partial reports, graceful restart, WAL/history, emergency/no auto-resume, LIVE rejection. No 24h run performed.",
  );
} catch (e) {
  console.error("FAILED stage: " + stage);
  console.error(e instanceof Error ? e.message : "INTEGRATION_FAILED");
  process.exitCode = 1;
} finally {
  try {
    compose("stop", "--timeout", "30", "bot");
    compose("rm", "-f", "bot");
  } catch {}
  console.log(
    `Retained test volumes: ${project}_validation-data, ${project}_validation-reports`,
  );
  assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
  assert.ok(basename(folder).startsWith("suiba-deepbook-"));
  rmSync(folder, { recursive: true, force: true });
}
