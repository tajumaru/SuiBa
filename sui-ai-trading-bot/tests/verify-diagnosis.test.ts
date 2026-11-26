import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { initialize } from "../docker/vps-data.mjs";

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "suiba-verify-"));
  folders.push(folder);
  const root = join(folder, "bot.sqlite");
  initialize(root, "NEW-PAPER-LEDGER");
  return { folder, root };
}

function diagnose(root: string) {
  const result = spawnSync(process.execPath, [
    "--import", "tsx", "docker/verify-diagnosis.mjs", root,
  ], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(result.stdout);
}

it("reports the verify token and up to 16 safe unknown DB names", () => {
  const { folder, root } = fixture();
  expect(diagnose(root)).toEqual({ error: null, unknown_files: [] });
  const safe = Array.from({ length: 18 }, (_, index) =>
    `orphan-${String(index).padStart(2, "0")}.sqlite`,
  );
  for (const name of [...safe, "bad name.sqlite", "a".repeat(122) + ".sqlite"]) {
    writeFileSync(join(folder, name), "");
  }
  expect(diagnose(root)).toEqual({
    error: "VPS_UNKNOWN_DATABASE",
    unknown_files: safe.slice(0, 16),
  });
});

it("withholds non-VPS exception details while still reporting unknown DB names", () => {
  const { folder, root } = fixture();
  rmSync(root + ".lifecycle.json");
  writeFileSync(join(folder, "orphan.sqlite"), "");
  expect(diagnose(root)).toEqual({ error: null, unknown_files: ["orphan.sqlite"] });
});
