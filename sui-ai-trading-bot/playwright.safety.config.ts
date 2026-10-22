import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";

// Use a built UI and separate port/artifacts so concurrent UI work cannot reset
// test authentication through HMR or remove this run's traces.
export default defineConfig({
  ...base,
  outputDir: "data/p0-browser-results",
  use: { ...base.use, baseURL: "http://127.0.0.1:5177" },
  webServer: {
    command: "node node_modules/vite/bin/vite.js preview apps/dashboard --host 127.0.0.1 --port 5177 --strictPort",
    url: "http://127.0.0.1:5177",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
