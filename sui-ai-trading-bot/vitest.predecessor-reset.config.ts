import { defineConfig } from "vitest/config";
import noWorker from "./vitest.no-worker.config.ts";

// Actual HTTP handler + engine hooks, with inert transports. Never Worker entrypoint.
export default defineConfig({
  plugins: noWorker.plugins,
  test: {
    include: ["tests/predecessor-reset-api.test.ts"],
    setupFiles: ["tests/loopback-guard.mjs", "tests/no-worker-guard.ts"],
    maxWorkers: 1,
  },
});
