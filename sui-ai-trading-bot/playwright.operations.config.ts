import base from "./playwright.config.ts";
export default {
  ...base,
  use: { ...base.use, baseURL: "http://127.0.0.1:5198" },
  projects: [320, 375, 768, 1024, 1440].map((width) => ({
    name: `width-${width}`,
    use: { viewport: { width, height: 900 } },
  })),
  webServer: {
    ...base.webServer,
    command:
      "node node_modules/vite/bin/vite.js apps/dashboard --host 127.0.0.1 --port 5198 --strictPort",
    url: "http://127.0.0.1:5198",
  },
};
