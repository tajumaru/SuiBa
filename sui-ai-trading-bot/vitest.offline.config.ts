import { assertNodeVersion } from "./scripts/verify-node-version.mjs";
import { defineConfig } from "vitest/config";
assertNodeVersion();
export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/settings-api.test.ts", "tests/deepbook-transport.test.ts"],
    setupFiles: ["tests/offline-guard.ts"],
    testNamePattern:
      /^(?!.*(?:actual loopback|actual HTTP 429|intercepts SDK HTTP calls|stalled real HTTP|aborts the real HTTP|actual socket disconnect))/,
  },
});
