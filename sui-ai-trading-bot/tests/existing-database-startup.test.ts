import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

it("refuses missing persisted state and a missing pair override before creating trading databases", () => {
  const folder = mkdtempSync(join(tmpdir(), "suiba-existing-"));
  try {
    const root = join(folder, "bot.sqlite");
    const start = (pair?: string) =>
      spawnSync(
        process.execPath,
        ["--import", "tsx", "apps/worker/src/index.ts"],
        {
          env: {
            ...process.env,
            MODE: "PAPER",
            ADMIN_TOKEN: "fixture-only-".repeat(4),
            ADMIN_TOKEN_FILE: "",
            REQUIRE_EXISTING_DATABASE: "1",
            DATABASE_PATH: root,
            TRADING_PAIR: pair ?? "",
            HOST: "127.0.0.1",
            PORT: "0",
            SUI_GRPC_URL: "https://127.0.0.1:1",
            DOTENV_CONFIG_QUIET: "true",
          },
          timeout: 10000,
          encoding: "utf8",
          windowsHide: true,
        },
      );
    let result = start();
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("BACKUP_DATABASE_SET_INCOMPLETE");
    expect(existsSync(root)).toBe(false);
    expect(existsSync(root + ".pairs.sqlite")).toBe(false);
    const selected = new DatabaseSync(root + ".pairs.sqlite");
    selected.exec(
      "CREATE TABLE bot_runtime_state(key TEXT PRIMARY KEY,json TEXT); INSERT INTO bot_runtime_state VALUES('selected_pair','\"WAL_USDC\"');",
    );
    selected.close();
    result = start();
    expect(result.stderr).toContain("BACKUP_SELECTED_DATABASE_MISSING");
    expect(existsSync(root + ".WAL_USDC.sqlite")).toBe(false);
    const selection = new DatabaseSync(root + ".pairs.sqlite");
    selection.exec("UPDATE bot_runtime_state SET json='\"SUI_USDC\"';");
    selection.close();
    const db = new DatabaseSync(root);
    db.exec("CREATE TABLE fixture(value TEXT)");
    db.close();
    const before = readFileSync(root);
    result = start("WAL_USDC");
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("EXISTING_DATABASE_REQUIRED");
    expect(existsSync(root + ".WAL_USDC.sqlite")).toBe(false);
    expect(readFileSync(root)).toEqual(before);
    result = start("SUI_USDC");
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("EXISTING_DATABASE_STATE_INCOMPLETE");
    expect(readFileSync(root)).toEqual(before);
    expect(existsSync(root + ".lifecycle.json")).toBe(false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 30000);
