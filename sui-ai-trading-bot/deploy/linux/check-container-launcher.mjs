// Disposable-container fixture ONLY. No host mounts or real secrets/services.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  chownSync,
} from "node:fs";
if (process.getuid?.() !== 0) throw Error("CONTAINER_FIXTURE_REQUIRES_ROOT");
const sha = "0".repeat(40),
  data = "/var/lib/suiba/bot.sqlite";
if (process.argv[2] === "--seed") {
  const { BotDatabase } = await import("../../packages/database/src/index.ts");
  const uid = Number(
    execFileSync("id", ["-u", "suiba"], { encoding: "utf8" }).trim(),
  );
  const gid = Number(
    execFileSync("id", ["-g", "suiba"], { encoding: "utf8" }).trim(),
  );
  for (const path of [data, data + ".pairs.sqlite"]) {
    const db = new BotDatabase(path);
    db.close();
    chownSync(path, uid, gid);
  }
  for (const path of [
    "/var/lib/suiba",
    "/var/lib/suiba-release",
    "/var/backups/suiba",
  ])
    chownSync(path, uid, gid);
  writeFileSync("/etc/suiba/admin-token", "container-fixture-only-".repeat(3), {
    mode: 0o640,
  });
  chownSync("/etc/suiba/admin-token", 0, gid);
  writeFileSync("/etc/suiba/backup.key", Buffer.alloc(32, 7), { mode: 0o600 });
  chownSync("/etc/suiba/backup.key", uid, gid);
  writeFileSync(data + ".maintenance", "fixture maintenance\n", {
    mode: 0o600,
  });
  chownSync(data + ".maintenance", uid, gid);
  symlinkSync("/opt/suiba/releases/" + sha, "/var/lib/suiba-release/current");
  process.exit(0);
}
const child = spawn(
  "/usr/bin/sudo",
  [
    "--non-interactive",
    "--user=suiba",
    "/usr/bin/env",
    "MODE=LIVE",
    "HOST=0.0.0.0",
    "PORT=3200",
    "DATABASE_PATH=/tmp/wrong-fixture.sqlite",
    "REQUIRE_EXISTING_DATABASE=0",
    "NODE_OPTIONS=--invalid-fixture-option",
    "/opt/suiba/tools/start-paper.sh",
  ],
  { stdio: ["ignore", "ignore", "inherit"] },
);
const exited = once(child, "exit");
let stopped = false;
try {
  const token = readFileSync("/etc/suiba/admin-token", "utf8").trim();
  let result;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const denied = await fetch("http://127.0.0.1:3100/api/deployment", {
        signal: AbortSignal.timeout(2000),
      });
      await denied.body?.cancel();
      if (denied.status !== 401) throw Error("FIXTURE_AUTH_NOT_ENFORCED");
      const response = await fetch("http://127.0.0.1:3100/api/deployment", {
        headers: { Authorization: "Bearer " + token },
        signal: AbortSignal.timeout(2000),
      });
      result = await response.json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (
    !result ||
    result.mode !== "PAPER" ||
    result.running !== false ||
    result.maintenance !== true ||
    result.revision !== sha ||
    result.databaseHealthy !== true ||
    result.ledgerOk !== true
  )
    throw Error("CONTAINER_LAUNCHER_PROBE_FAILED");
  child.kill("SIGTERM");
  await exited;
  stopped = true;
  const receipt = JSON.parse(readFileSync(data + ".lifecycle.json", "utf8"));
  if (receipt.state !== "clean") throw Error("CONTAINER_LAUNCHER_STOP_FAILED");
  console.log("CONTAINER_ROOT_OWNED_LAUNCHER_PAPER_AND_CLEAN_STOP_OK");
} finally {
  if (!stopped && child.exitCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
}
