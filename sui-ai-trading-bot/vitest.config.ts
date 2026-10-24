import { defineConfig } from "vitest/config";
import { assertNodeVersion } from "./scripts/verify-node-version.mjs";
assertNodeVersion();
export default defineConfig({});
