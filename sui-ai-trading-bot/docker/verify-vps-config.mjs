// Parse the real Compose model without creating containers, networks or volumes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const model = JSON.parse(
  execFileSync(
    "docker",
    [
      "compose",
      "-f",
      "docker/compose.vps.yaml",
      "config",
      "--no-env-resolution",
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, SUIBA_IMAGE: "suiba:validation" },
    },
  ),
);
const bot = model.services.bot;
assert.equal(model.name, "suiba-vps");
assert.equal(Number(bot.mem_limit), 1024 ** 3);
assert.equal(bot.memswap_limit, bot.mem_limit);
assert.equal(bot.environment.MODE, "PAPER");
assert.equal(bot.environment.REQUIRE_EXISTING_DATABASE, "1");
assert.equal(bot.environment.ADMIN_TOKEN_FILE, "/run/secrets/admin-token");
assert.equal(bot.environment.NODE_OPTIONS, "--max-old-space-size=640");
assert.equal(bot.ports.length, 1);
assert.equal(bot.ports[0].host_ip, "127.0.0.1");
assert.equal(bot.read_only, true);
assert.equal(bot.init, true);
assert.equal(bot.stop_grace_period, "40s");
assert.equal(bot.build, undefined);
for (const name of ["vps-data", "vps-reports"])
  assert.equal(model.volumes[name].external, true);
console.log(
  "PASS: rendered VPS Compose safety and resource limits (no containers started)",
);
