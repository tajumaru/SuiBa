// Real Docker/Compose integration with a plain HTTP/process fixture, NEVER Worker.
// No API control/start, external networking, VPS access or production volumes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
const image = process.argv[2];
assert.ok(image, "image required");
const project = `suiba-vps-offline-${randomBytes(6).toString("hex")}`;
const folder = mkdtempSync(join(tmpdir(), project));
const volumes = ["data", "scratch", "restore"].map((s) => `${project}-${s}`);
const [data, scratch, restored] = volumes;
const file = join(folder, "override.yaml");
const envFile = join(folder, "runtime.env"),
  secret = join(folder, "token");
writeFileSync(envFile, "");
writeFileSync(secret, randomBytes(32).toString("hex"));
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 ** 2,
  }).trim();
const dc = (...args) =>
  docker(
    "compose",
    "-p",
    project,
    "-f",
    resolve("docker/compose.vps.yaml"),
    "-f",
    file,
    ...args,
  );
const helper = (volume, command, ...extra) =>
  docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
    "-v",
    `${volume}:/app/data`,
    image,
    "node",
    "--import",
    "tsx",
    "docker/vps-data.mjs",
    command,
    ...extra,
  );
function override(command, restart = "unless-stopped") {
  writeFileSync(
    file,
    `services:\n  bot:\n    image: ${JSON.stringify(image)}\n    env_file: !override [${JSON.stringify(envFile)}]\n    network_mode: none\n    restart: ${JSON.stringify(restart)}\n    ports: !reset []\n    command: ${JSON.stringify(["node", "-e", command])}\nsecrets:\n  admin-token:\n    file: ${JSON.stringify(secret)}\nvolumes:\n  vps-data:\n    name: ${data}\n  vps-reports:\n    name: ${scratch}\n`,
  );
}
process.env.SUIBA_IMAGE = image;
let cid;
const fixture =
  "const http=require('node:http'); const s=http.createServer((q,r)=>{r.setHeader('Content-Type','application/json');r.end(JSON.stringify({status:'ok',mode:'PAPER'}));});s.listen(3100,'0.0.0.0');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));";
override(fixture);
try {
  for (const volume of volumes) docker("volume", "create", volume);
  console.log(
    "UID1000 maintenance and explicit empty-volume initialization (no Worker)",
  );
  helper(data, "maintenance");
  assert.equal(
    docker(
      "run",
      "--rm",
      "--init",
      "--network",
      "none",
      "-v",
      `${data}:/app/data`,
      image,
      "node",
      "-e",
      "console.log(require('fs').statSync('/app/data/bot.sqlite.maintenance').uid)",
    ),
    "1000",
  );
  helper(data, "initialize", "NEW-PAPER-LEDGER");
  helper(data, "verify");
  const denied = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
      "-v",
      `${data}:/app/data:ro`,
      image,
      "node",
      "--import",
      "tsx",
      "docker/vps-data.mjs",
      "maintenance",
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(denied.status, 0, "read-only maintenance must fail");
  console.log(
    "WAL/SHM recovery and full cold archive restore (SQLite fixture only)",
  );
  const crash = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--network",
      "none",
      "-v",
      `${data}:/app/data`,
      image,
      "node",
      "--input-type=module",
      "-e",
      `import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('/app/data/bot.sqlite');d.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE vps_evidence(value TEXT);INSERT INTO vps_evidence VALUES('retained-wal')");process.kill(process.pid,'SIGKILL');`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(crash.status, 137);
  const archive = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
      "-v",
      `${data}:/app/data`,
      "-v",
      `${scratch}:/app/reports`,
      image,
      "node",
      "--import",
      "tsx",
      "docker/vps-data.mjs",
      "backup",
    ],
    { maxBuffer: 16 * 1024 ** 2 },
  );
  const listing = execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--entrypoint",
      "tar",
      image,
      "-tf",
      "-",
    ],
    { input: archive, encoding: "utf8" },
  );
  assert.match(listing, /bot.sqlite-wal/);
  assert.match(listing, /bot.sqlite-shm/);
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "-v",
      `${restored}:/app/data`,
      "--entrypoint",
      "tar",
      image,
      "-C",
      "/app/data",
      "-xf",
      "-",
    ],
    { input: archive },
  );
  helper(restored, "verify");
  assert.equal(
    docker(
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${restored}:/app/data`,
      image,
      "node",
      "--input-type=module",
      "-e",
      "import {DatabaseSync} from 'node:sqlite';const d=new DatabaseSync('/app/data/bot.sqlite',{readOnly:true});console.log(d.prepare('SELECT value FROM vps_evidence').get().value);d.close()",
    ),
    "retained-wal",
  );
  console.log(
    "Real VPS Compose health, limits, SIGTERM, recreation using HTTP fixture (no Worker)",
  );
  override(fixture);
  dc("up", "-d", "--no-build", "--wait", "--wait-timeout", "120");
  cid = dc("ps", "-q", "bot");
  const config = JSON.parse(docker("inspect", cid))[0];
  assert.equal(config.Config.User, "node");
  assert.equal(config.HostConfig.Memory, 1024 ** 3);
  assert.equal(config.HostConfig.MemorySwap, 1024 ** 3);
  assert.equal(config.HostConfig.ReadonlyRootfs, true);
  assert.equal(config.State.Health.Status, "healthy");
  assert.equal(config.Config.StopTimeout, 40);
  dc("stop", "--timeout", "40", "bot");
  assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", cid), "0");
  dc(
    "up",
    "-d",
    "--no-build",
    "--force-recreate",
    "--wait",
    "--wait-timeout",
    "120",
  );
  cid = dc("ps", "-q", "bot");
  dc("stop", "--timeout", "40", "bot");
  console.log(
    "Actual 40-second SIGTERM timeout (signal-ignoring fixture only)",
  );
  override(
    "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)",
  );
  dc("up", "-d", "--no-build");
  cid = dc("ps", "-q", "bot");
  for (let i = 0; i < 50; i++) {
    if (dc("logs", "--no-color", "bot").includes("ready")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const began = Date.now();
  dc("stop", "--timeout", "40", "bot");
  assert.ok(Date.now() - began >= 39000);
  assert.equal(
    docker("inspect", "--format", "{{.State.ExitCode}}", cid),
    "137",
  );
  console.log(
    "Actual 1GiB cgroup OOM (allocator fixture only, restart disabled)",
  );
  override(
    "const a=[];setInterval(()=>{a.push(Buffer.alloc(32*1024*1024,1))},25)",
    "no",
  );
  dc("up", "-d", "--no-build");
  cid = dc("ps", "-q", "bot");
  docker("wait", cid);
  const oom = JSON.parse(docker("inspect", cid))[0];
  assert.equal(oom.State.OOMKilled, true);
  assert.equal(oom.State.ExitCode, 137);
  console.log(
    "PASS: offline data/Compose/process verification; no Worker was started",
  );
} finally {
  try {
    dc("down", "--timeout", "5");
  } catch {}
  for (const volume of volumes) {
    try {
      docker("volume", "rm", volume);
    } catch {}
  }
  assert.equal(dirname(resolve(folder)), resolve(tmpdir()));
  assert.ok(basename(folder).startsWith(project));
  rmSync(folder, { recursive: true, force: true });
}
