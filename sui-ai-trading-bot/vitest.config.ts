import { configDefaults, defineConfig } from "vitest/config";
import { assertNodeVersion } from "./scripts/verify-node-version.mjs";
assertNodeVersion();
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "tools/sui-transport-bench/bench.test.mjs",
    ],
  },
});
