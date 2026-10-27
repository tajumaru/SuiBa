import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertNodeVersion } from "./verify-node-version.mjs";
assertNodeVersion();
const base = resolve("data/loopback-test-tmp");
mkdirSync(base, { recursive: true });
const folder = mkdtempSync(join(base, "run-"));
const emptyEnv = join(folder, "empty.env");
writeFileSync(emptyEnv, "# isolated loopback test environment\n", {
  flag: "wx",
});
const guard = pathToFileURL(resolve("tests/loopback-guard.mjs")).href;
const env = { ...process.env };
for (const name of [
  "ADMIN_TOKEN",
  "ADMIN_TOKEN_FILE",
  "DATABASE_PATH",
  "READ_ONLY_ADDRESS",
  "SUI_GRPC_URL",
  "MARKET_POOL",
  "VALIDATION_ENABLED",
  "DEEPBOOK_VALIDATION",
  "VALIDATION_REPORT_DIR",
  "MARKET_DATA_PROVIDER",
  "DEEPBOOK_RECONSTRUCT_CANDLES",
  "SUIBA_BUILD_SHA",
  "SUIBA_IMAGE_ID",
  "MODE",
  "PORT",
  "HOST",
])
  delete env[name];
Object.assign(env, {
  TEMP: folder,
  TMP: folder,
  DOTENV_CONFIG_PATH: emptyEnv,
  // Replace inherited preload settings. Every descendant gets the same guard.
  NODE_OPTIONS: `--import=${guard}`,
});
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.loopback.config.ts",
    ...process.argv.slice(2),
  ],
  { env, stdio: "inherit", windowsHide: true },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
