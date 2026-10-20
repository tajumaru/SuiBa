import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    browserName: "chromium",
    trace: "retain-on-failure",
  },
  projects: [375, 390, 430, 1280].map((width) => ({
    name: `width-${width}`,
    use: {
      viewport: { width, height: 900 },
      isMobile: width < 600,
      hasTouch: width < 600,
    },
  })),
  webServer: {
    command:
      "pnpm exec vite apps/dashboard --host 127.0.0.1 --port 5174 --strictPort",
    url: "http://127.0.0.1:5174",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
