import { defineConfig } from "vitest/config";
import { assertNodeVersion } from "./scripts/verify-node-version.mjs";
assertNodeVersion();
export default defineConfig({
  test: {
    include: [
      "tests/api-access.test.ts",
      "tests/http-errors.test.ts",
      "tests/sui-diagnostics.test.ts",
      "tests/deepbook-transport.test.ts",
      "tests/settings-api.test.ts",
      "tests/loopback-guard.loopback.ts",
    ],
    setupFiles: ["tests/loopback-guard.mjs"],
    // Keep short actual-I/O deadlines independent from other test files' load.
    fileParallelism: false,
  },
});
