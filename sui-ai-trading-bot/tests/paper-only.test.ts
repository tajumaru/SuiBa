import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
it.each(["geckoterminal", "deepbook", "auto"])(
  "refuses LIVE with %s before opening a database or starting a server",
  async (provider) => {
    const folder = mkdtempSync(join(tmpdir(), "suiba-live-denial-")),
      path = join(folder, "must-not-exist.sqlite");
    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/worker/src/index.ts"],
        {
          env: {
            ...process.env,
            MODE: "LIVE",
            MARKET_DATA_PROVIDER: provider,
            DATABASE_PATH: path,
            ADMIN_TOKEN: "test-only-no-real-secret-000000000",
          },
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const exit = await new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
      });
      expect(exit).not.toBe(0);
      expect(stderr).toContain("ONLY_PAPER_SUPPORTED");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
  15000,
);
