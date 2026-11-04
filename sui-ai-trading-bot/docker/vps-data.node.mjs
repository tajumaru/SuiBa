import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runInNewContext } from "node:vm";
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

test("copied-database diagnostics expose only safe runtime codes and preserve the copies", () => {
  const folder = mkdtempSync(join(tmpdir(), "suiba-runtime-diagnostic-"));
  const controller = readFileSync(
    new URL("../deploy/paper-check/controller.py", import.meta.url),
    "utf8",
  );
  const query = controller.match(/DIAGNOSTIC_QUERY = """([\s\S]*?)"""/)[1];
  const errors = [
    ...controller
      .match(/RUNTIME_ERROR_CODES = \(([\s\S]*?)\)/)[1]
      .matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);
  const snapshots = new Map();
  try {
    for (const name of ["before", "after"]) mkdirSync(join(folder, name));
    for (const name of [
      "bot.sqlite",
      "bot.sqlite.WAL_USDC.sqlite",
      "bot.sqlite.instance.sqlite",
      "bot.sqlite.pairs.sqlite",
    ]) {
      for (const snapshot of ["before", "after"]) {
        const path = join(folder, snapshot, name);
        const db = new DatabaseSync(path);
        db.exec(
          "CREATE TABLE bot_runtime_state(key TEXT PRIMARY KEY,json TEXT);CREATE TABLE operation_events(json TEXT);CREATE TABLE paper_orders(id TEXT);CREATE TABLE paper_trades(id TEXT)",
        );
        db.prepare("INSERT INTO bot_runtime_state VALUES (?,?)").run(
          "runtime",
          JSON.stringify({
            running: false,
            emergency: false,
            error:
              name === "bot.sqlite"
                ? "API_CANCELLED"
                : "secret-fixture-never-display",
          }),
        );
        db.prepare("INSERT INTO bot_runtime_state VALUES (?,?)").run(
          "selected_pair",
          JSON.stringify("SUI_USDC"),
        );
        db.close();
        snapshots.set(path, readFileSync(path));
      }
    }
    let result;
    const script = query
      .replace("RUNTIME_ERROR_ALLOWLIST", JSON.stringify(errors))
      .replaceAll("/audit/", folder.replaceAll("\\", "/") + "/");
    const execute = () =>
      runInNewContext(script, {
        require: (name) => {
          assert.equal(name, "node:sqlite");
          return { DatabaseSync };
        },
        console: {
          log: (value) => {
            result = JSON.parse(value);
          },
        },
      });
    execute();
    assert.equal(result.selected_pair, "SUI_USDC");
    assert.deepEqual(result.deltas["bot.sqlite"], [0, 0, 0]);
    assert.deepEqual(result.runtime["bot.sqlite"], {
      running: false,
      emergency: false,
      error: "API_CANCELLED",
      before_error: "API_CANCELLED",
    });
    assert.equal(
      result.runtime["bot.sqlite.WAL_USDC.sqlite"].error,
      "OTHER_RUNTIME_ERROR",
    );
    assert.ok(!JSON.stringify(result).includes("secret-fixture"));
    for (const [path, data] of snapshots)
      assert.deepEqual(readFileSync(path), data);
    writeFileSync(
      join(folder, "after", "bot.sqlite.pairs.sqlite"),
      "corrupt fixture",
    );
    assert.throws(execute);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
