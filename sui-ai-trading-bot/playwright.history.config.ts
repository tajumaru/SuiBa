import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "operations.pw.ts",
  grep: /history fits the phone width/,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5199",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    ...[320, 375, 390].map((width) => ({
      name: `webkit-${width}`,
      use: {
        browserName: "webkit" as const,
        viewport: { width, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    })),
    {
      name: "chromium-desktop",
      use: { browserName: "chromium", viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js apps/dashboard --host 127.0.0.1 --port 5199 --strictPort",
    url: "http://127.0.0.1:5199",
    reuseExistingServer: false,
  },
});
