// Optional Docker integration check. Uses a NEW volume; never removes any volume.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
const suffix = randomBytes(6).toString("hex");
const name = `suiba-verify-${suffix}`,
  volume = `${name}-data`,
  image = `suiba-verify:${suffix}`;
const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
let created = false;
try {
  docker("version");
  console.log("Building isolated PAPER verification image...");
  docker("build", "-f", "docker/Dockerfile", "-t", image, ".");
  docker("volume", "create", volume);
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--mount",
    `type=volume,source=${volume},target=/app/data`,
    "-e",
    "MODE=PAPER",
    "-e",
    `ADMIN_TOKEN=${randomBytes(32).toString("hex")}`,
    "-e",
    "SUI_GRPC_URL=https://127.0.0.1:1",
    image,
  );
  created = true;
  async function ready() {
    for (let i = 0; i < 60; i++) {
      try {
        docker("exec", name, "node", "docker/healthcheck.mjs");
        return;
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("DOCKER_HEALTH_TIMEOUT");
  }
  await ready();
  docker(
    "exec",
    name,
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `
    import { BotDatabase } from './packages/database/src/index.ts';
    const db = new BotDatabase('/app/data/bot.sqlite');
    db.append('paper_trades', 'docker-retention', { orderId: 'docker-retention', timestamp: 1 });
    db.set('runtime', { ...db.runtime(), running: true, emergency: true });
    db.close();
  `,
  );
  docker("restart", "--time", "30", name);
  await ready();
  docker(
    "exec",
    name,
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { BotDatabase } from './packages/database/src/index.ts';
    const db = new BotDatabase('/app/data/bot.sqlite');
    assert.equal(db.runtime().running, false);
    assert.equal(db.runtime().emergency, true);
    assert.equal(db.history('paper_trades')[0].orderId, 'docker-retention');
    db.close();
  `,
  );
  console.log(
    "PASS: Linux startup, health, restart stopped, emergency and SQLite history retained.",
  );
} catch {
  // Do not print exec errors: docker arguments can contain the ephemeral token.
  console.error(
    "Docker verification failed or Docker is unavailable. No success claimed.",
  );
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      docker("rm", "-f", name);
    } catch {}
  }
  console.log(`Verification volume retained (if created): ${volume}`);
  console.log(`Verification image retained (if built): ${image}`);
}
