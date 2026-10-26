import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.ts";
export default defineConfig({
  ...base,
  testMatch: "**/login.pw.ts",
  outputDir: "data/auth-browser-results",
  use: {
    ...base.use,
    baseURL: "http://127.0.0.1:5191",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "desktop", use: { browserName: "chromium" } },
    {
      name: "iphone-webkit",
      use: { ...devices["iPhone 13"], browserName: "webkit" },
    },
  ],
  webServer: {
    ...base.webServer,
    command:
      "node node_modules/vite/bin/vite.js apps/dashboard --host 127.0.0.1 --port 5191 --strictPort",
    url: "http://127.0.0.1:5191",
  },
});
