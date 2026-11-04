import { execSync } from "node:child_process";
import { defineConfig, type Plugin } from "vite";

// The running build's identity, stamped from git at build time.
// The dashboard shows it in the footer and polls version.json to
// notice when a newer build has been deployed — a stale page
// otherwise looks alive forever because its data keeps polling.
// Falls back to "dev" outside a git checkout (never triggers
// the update banner).
function gitInfo() {
  try {
    const run = (cmd: string) => execSync(cmd, { encoding: "utf8" }).trim();
    return {
      build: run("git rev-parse --short HEAD"),
      subject: run("git log -1 --format=%s"),
    };
  } catch {
    return { build: "dev", subject: "" };
  }
}
const info = gitInfo();
const versionAsset: Plugin = {
  name: "suiba-version-json",
  generateBundle() {
    this.emitFile({
      type: "asset",
      fileName: "version.json",
      source: JSON.stringify({
        build: info.build,
        subject: info.subject,
        builtAt: new Date().toISOString(),
      }),
    });
  },
};
export default defineConfig({
  server: { proxy: { "/api": "http://127.0.0.1:3100" } },
  build: { outDir: "dist" },
  define: {
    __APP_BUILD__: JSON.stringify(info.build),
    __APP_SUBJECT__: JSON.stringify(info.subject),
  },
  plugins: [versionAsset],
});
