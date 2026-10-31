import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { maintenance, initialize, verify } from "./vps-data.mjs";

test(
  "offline provisioning, migration and rejected overwrite/corruption",
  { skip: process.platform !== "linux" },
  () => {
    const folder = mkdtempSync(join(tmpdir(), "suiba-vps-data-"));
    const root = join(folder, "bot.sqlite");
    try {
      assert.throws(() => initialize(root, ""), /CONFIRMATION/);
      initialize(root, "NEW-PAPER-LEDGER");
      verify(root);
      const before = readFileSync(root);
      assert.throws(() => initialize(root, "NEW-PAPER-LEDGER"), /EMPTY_VOLUME/);
      assert.deepEqual(readFileSync(root), before);
      const db = new DatabaseSync(root);
      db.prepare("UPDATE bot_runtime_state SET json=? WHERE key='runtime'").run(
        JSON.stringify({ running: true }),
      );
      db.close();
      assert.throws(() => verify(root), /NOT_STOPPED/);
      writeFileSync(
        root + ".lifecycle.json",
        JSON.stringify({ version: 1, mode: "PAPER", state: "running" }),
      );
      assert.throws(() => verify(root), /UNCLEAN_SHUTDOWN/);
      writeFileSync(
        root + ".lifecycle.json",
        JSON.stringify({ version: 1, mode: "PAPER", state: "clean" }),
      );
      writeFileSync(root, "corrupt-sqlite-fixture");
      assert.throws(() => verify(root));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);

test(
  "maintenance rejects symlinks without modifying their target",
  { skip: process.platform !== "linux" },
  () => {
    const folder = mkdtempSync(join(tmpdir(), "suiba-vps-gate-"));
    try {
      const target = join(folder, "target"),
        root = join(folder, "bot.sqlite");
      writeFileSync(target, "retained");
      symlinkSync(target, root + ".maintenance");
      assert.throws(() => maintenance(root));
      assert.equal(readFileSync(target, "utf8"), "retained");
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
