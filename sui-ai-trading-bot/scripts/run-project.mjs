import { assertNodeVersion } from "./verify-node-version.mjs";
import { spawnSync } from "node:child_process";
import { dirname, delimiter } from "node:path";
assertNodeVersion();
const tasks = {
  typecheck: [["node_modules/typescript/bin/tsc", "--noEmit"]],
  build: [
    ["node_modules/typescript/bin/tsc", "--noEmit"],
    ["node_modules/vite/bin/vite.js", "build", "apps/dashboard"],
  ],
  test: [
    ["--test", "tests/preflight-quality.node.cjs"],
    ["node_modules/vitest/vitest.mjs", "run"],
  ],
  "test:offline": [
    ["--test", "tests/preflight-quality.node.cjs"],
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.offline.config.ts",
    ],
  ],
  "test:e2e": [["node_modules/@playwright/test/cli.js", "test"]],
  dev: [
    [
      "--import",
      "./scripts/enforce-node-version.mjs",
      "--import",
      "tsx",
      "apps/worker/src/index.ts",
    ],
  ],
  dashboard: [
    ["node_modules/vite/bin/vite.js", "apps/dashboard", "--host", "127.0.0.1"],
  ],
  backtest: [["--import", "tsx", "apps/worker/src/backtest.ts"]],
  smoke: [["--import", "tsx", "apps/worker/src/smoke.ts"]],
  "verify:runtime": [["--import", "tsx", "apps/worker/src/verify-runtime.ts"]],
  "backtest:sample": [
    ["--import", "tsx", "apps/worker/src/backtest-sample.ts"],
  ],
  format: [
    [
      "node_modules/prettier/bin/prettier.cjs",
      "--write",
      "apps",
      "packages",
      "tests",
      "README.md",
      "tsconfig.json",
      "package.json",
      "docker",
      "pnpm-workspace.yaml",
    ],
  ],
};
const name = process.argv[2],
  steps = tasks[name];
if (!steps) throw Error("UNKNOWN_PROJECT_TASK");
const extra = process.argv.slice(3);
if (extra[0] === "--") extra.shift();
for (const [index, args] of steps.entries()) {
  // Pin all child tools and their shims to this exact interpreter. Do not trust PATH.
  const child = spawnSync(
    process.execPath,
    [...args, ...(index === steps.length - 1 ? extra : [])],
    {
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        PATH: dirname(process.execPath) + delimiter + (process.env.PATH ?? ""),
      },
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}
