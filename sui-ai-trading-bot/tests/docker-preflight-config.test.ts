import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
it("pins a single Docker build/runtime Node and includes the runtime guard", () => {
  const docker = readFileSync("docker/Dockerfile", "utf8");
  expect(docker.match(/^FROM /gm)).toHaveLength(1);
  expect(docker).toContain(
    "FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205",
  );
  expect(docker).toContain("COPY scripts ./scripts");
  expect(
    docker.indexOf("RUN node scripts/verify-node-version.mjs"),
  ).toBeLessThan(docker.indexOf("pnpm install --frozen-lockfile"));
  expect(docker).toContain(
    'CMD ["node", "--import", "./scripts/enforce-node-version.mjs"',
  );
});
it("isolates the pending preflight from protected ports and existing state", () => {
  const compose = readFileSync("docker/compose.preflight-30m.yaml", "utf8");
  expect(compose).toContain("127.0.0.1:3105:3100");
  expect(compose).toMatch(/restart: ["']no["']/);
  expect(compose).toContain("read_only: true");
  expect(compose).toContain("SUIBA_PREFLIGHT_PROJECT:?");
  expect(compose).toContain("SUIBA_PREFLIGHT_IMAGE:?");
  expect(compose).toContain("SUIBA_PREFLIGHT_SECRET_FILE:?");
  expect(compose).toContain("preflight-data:/app/validation");
  expect(compose).toContain("preflight-reports:/app/reports");
  expect(compose).not.toMatch(
    /env_file:|external:\s*true|container_name:|^\s+build:|127\.0\.0\.1:310[014]:|paper-data:|validation-data:|run2-data:/m,
  );
});
it("keeps pending preflight in PAPER with no implicit control start and local metrics only", () => {
  const compose = readFileSync("docker/compose.preflight-30m.yaml", "utf8");
  expect(compose).toContain("MODE: PAPER");
  expect(compose).toContain("preflight-metrics-preload.mjs");
  expect(compose).not.toMatch(/MODE: LIVE|\/api\/control|command:\s*start/);
  const metrics = readFileSync("scripts/preflight-passive-metrics.mjs", "utf8");
  expect(metrics).not.toMatch(/fetch\(|\.request\(|new DatabaseSync|\.ping\(/);
});
