import { defineConfig } from "@playwright/test";

/** Safari's engine as well as Chromium, including compact landscape. */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "mobile-recovery.pw.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5186",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "webkit-se",
      use: {
        browserName: "webkit",
        viewport: { width: 375, height: 667 },
        isMobile: true,
        hasTouch: true,
      },
    },
    ...[375, 390, 430].map((width) => ({
      name: `webkit-${width}`,
      use: {
        browserName: "webkit" as const,
        viewport: { width, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    })),
    {
      name: "webkit-landscape",
      use: {
        browserName: "webkit",
        viewport: { width: 844, height: 390 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "chromium-390",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "chromium-desktop",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 900 },
      },
    },
  ],
  webServer: {
    command:
      "node node_modules/vite/bin/vite.js apps/dashboard --host 127.0.0.1 --port 5186 --strictPort",
    url: "http://127.0.0.1:5186",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
