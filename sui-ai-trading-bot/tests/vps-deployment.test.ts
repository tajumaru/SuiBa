import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const compose = readFileSync("docker/compose.vps.yaml", "utf8");
const deploy = readFileSync("docker/deploy-vps.sh", "utf8");

it("bounds VPS resource use and preserves authenticated PAPER state", () => {
  for (const value of [
    "mem_limit: 1024m",
    "memswap_limit: 1024m",
    "--max-old-space-size=640",
    "pids_limit: 128",
    "MODE: PAPER",
    'REQUIRE_EXISTING_DATABASE: "1"',
    "ADMIN_TOKEN_FILE: /run/secrets/admin-token",
    "127.0.0.1:3100:3100",
    "stop_grace_period: 40s",
    "read_only: true",
    "name: suiba-vps-data",
    "name: suiba-vps-reports",
  ])
    expect(compose).toContain(value);
  expect(compose.match(/external: true/g)).toHaveLength(2);
  expect(compose).not.toMatch(/build:|privileged:|docker.sock|MODE: LIVE/);
});

it("gates trading, serializes deployment and backs up only after graceful exit", () => {
  expect(deploy).toContain("flock -n 9");
  expect(deploy).toContain("sha256sum --check");
  expect(deploy.indexOf("bot.sqlite.maintenance")).toBeLessThan(
    deploy.indexOf("dc stop"),
  );
  expect(deploy.indexOf(".State.ExitCode")).toBeLessThan(
    deploy.indexOf("--entrypoint tar"),
  );
  expect(deploy.indexOf("--entrypoint tar")).toBeLessThan(
    deploy.indexOf("dc up"),
  );
  expect(deploy).not.toMatch(
    /down.*-v|volume rm|system prune|\/api\/control|docker build/,
  );
});
