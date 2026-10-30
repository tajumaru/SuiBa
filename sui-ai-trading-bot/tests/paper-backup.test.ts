import { afterEach, expect, it as test } from "vitest";
// Multi-database, fsync-backed restore exercises can exceed the unit-test default
// on Windows. This affects only these new disk integration tests.
const it = (name: string, run: () => Promise<void>) => test(name, run, 30000);
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  acquireInstanceLock,
  recordLifecycle,
} from "../apps/worker/src/deployment-safety.ts";
import {
  createPaperBackup,
  restorePaperBackup,
  verifyPaperBackup,
} from "../apps/worker/src/paper-backup.ts";

const folders: string[] = [];
afterEach(() => {
  for (const path of folders.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "suiba-backup-"));
  folders.push(folder);
  const root = join(folder, "bot.sqlite"),
    backup = join(folder, "backup");
  for (const path of [
    root,
    root + ".WAL_USDC.sqlite",
    root + ".pairs.sqlite",
  ]) {
    const db = new BotDatabase(path);
    db.set("runtime", { ...db.runtime(), running: false, emergency: true });
    db.set("fixture_guard", { highWater: "1234.56", locked: true });
    db.append("paper_trades", "old-paper-trade", {
      timestamp: 10,
      orderId: "old-paper-trade",
    });
    if (path.endsWith(".pairs.sqlite")) db.set("selected_pair", "WAL_USDC");
    db.close();
  }
  const history = new DatabaseSync(root + ".chart-history.sqlite");
  history.exec(
    "CREATE TABLE candles(value TEXT); INSERT INTO candles VALUES('history');",
  );
  history.close();
  recordLifecycle(root, "fixture-boot", "clean");
  writeFileSync(root + ".maintenance", "");
  return { root, backup, folder };
}

it("backs up all pair/history DBs and rehearses restore without changing current data", async () => {
  const t = fixture();
  const before = readFileSync(t.root);
  const manifest = await createPaperBackup(t.root, t.backup);
  expect(manifest.databases).toHaveLength(4);
  expect(readFileSync(t.root)).toEqual(before);
  expect(verifyPaperBackup(t.backup).bootId).toBe("fixture-boot");
  const target = join(t.folder, "restored");
  restorePaperBackup(t.backup, target);
  for (const suffix of ["", ".WAL_USDC.sqlite"]) {
    const restored = new BotDatabase(join(target, "bot.sqlite" + suffix));
    expect(restored.runtime()).toMatchObject({
      running: false,
      emergency: true,
    });
    expect(restored.history("paper_trades")).toHaveLength(1);
    expect(restored.get("fixture_guard")).toEqual({
      highWater: "1234.56",
      locked: true,
    });
    restored.close();
  }
  const selection = new BotDatabase(join(target, "bot.sqlite.pairs.sqlite"));
  expect(selection.get("selected_pair")).toBe("WAL_USDC");
  selection.close();
  expect(existsSync(join(target, "bot.sqlite.maintenance"))).toBe(true);
  expect(existsSync(join(target, "bot.sqlite.lifecycle.json"))).toBe(false);
  expect(() => restorePaperBackup(t.backup, target)).toThrow();
});

it("refuses live ownership, unclean shutdown and running persisted state", async () => {
  const t = fixture(),
    lock = acquireInstanceLock(t.root);
  await expect(createPaperBackup(t.root, t.backup)).rejects.toThrow(
    "INSTANCE_LOCK_UNAVAILABLE",
  );
  lock.close();
  recordLifecycle(t.root, "crash", "running");
  await expect(createPaperBackup(t.root, t.backup)).rejects.toThrow(
    "BACKUP_REQUIRES_CLEAN_SHUTDOWN",
  );
  recordLifecycle(t.root, "fixture-boot", "clean");
  const db = new BotDatabase(t.root);
  db.set("runtime", { ...db.runtime(), running: true });
  db.close();
  await expect(createPaperBackup(t.root, t.backup)).rejects.toThrow(
    "BACKUP_REQUIRES_STOPPED_RUNTIME",
  );
  expect(existsSync(t.backup)).toBe(false);
});

it("does not omit unknown DBs or overwrite an existing backup", async () => {
  const t = fixture();
  writeFileSync(t.root + ".auth.sqlite", "unknown");
  await expect(createPaperBackup(t.root, t.backup)).rejects.toThrow(
    "BACKUP_UNKNOWN_DATABASE",
  );
  rmSync(t.root + ".auth.sqlite");
  await createPaperBackup(t.root, t.backup);
  await expect(createPaperBackup(t.root, t.backup)).rejects.toThrow();
  expect(verifyPaperBackup(t.backup).databases).toHaveLength(4);
});

it("rejects modified bytes, injected WAL and path traversal manifests before restore", async () => {
  const t = fixture();
  await createPaperBackup(t.root, t.backup);
  const file = join(t.backup, "bot.sqlite"),
    original = readFileSync(file);
  writeFileSync(file, "changed");
  expect(() => verifyPaperBackup(t.backup)).toThrow("BACKUP_HASH_MISMATCH");
  writeFileSync(file, original);
  writeFileSync(file + "-wal", "untrusted");
  expect(() => verifyPaperBackup(t.backup)).toThrow(
    "BACKUP_UNEXPECTED_SIDECAR",
  );
  rmSync(file + "-wal");
  const manifestPath = join(t.backup, "manifest.json"),
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.databases[0].name = "../bot.sqlite";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const target = join(t.folder, "restored");
  expect(() => restorePaperBackup(t.backup, target)).toThrow(
    "INVALID_BACKUP_MANIFEST",
  );
  expect(existsSync(target)).toBe(false);
});

it("refuses a missing selected pair, invalid selection and orphan SQLite sidecars", async () => {
  const t = fixture();
  rmSync(t.root + ".WAL_USDC.sqlite");
  await expect(createPaperBackup(t.root, t.backup)).rejects.toThrow(
    "BACKUP_SELECTED_DATABASE_MISSING",
  );
  expect(existsSync(t.backup)).toBe(false);
  const selection = new BotDatabase(t.root + ".pairs.sqlite");
  selection.set("selected_pair", "UNKNOWN_PAIR");
  selection.close();
  await expect(createPaperBackup(t.root, t.backup)).rejects.toThrow(
    "BACKUP_INVALID_SELECTED_PAIR",
  );
  writeFileSync(t.root + ".WAL_USDC.sqlite.chart-history.sqlite-wal", "orphan");
  await expect(createPaperBackup(t.root, t.backup)).rejects.toThrow(
    "BACKUP_ORPHAN_SIDECAR",
  );
});

it("rejects manifest omissions even when the remaining DB hashes are valid", async () => {
  const t = fixture();
  await createPaperBackup(t.root, t.backup);
  const manifestPath = join(t.backup, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.databases = manifest.databases.filter(
    (entry: { name: string }) => entry.name !== "bot.sqlite.WAL_USDC.sqlite",
  );
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const target = join(t.folder, "omitted-restore");
  expect(() => restorePaperBackup(t.backup, target)).toThrow(
    "BACKUP_UNLISTED_DATABASE",
  );
  rmSync(join(t.backup, "bot.sqlite.WAL_USDC.sqlite"));
  expect(() => restorePaperBackup(t.backup, target)).toThrow(
    "BACKUP_SELECTED_DATABASE_MISSING",
  );
  expect(existsSync(target)).toBe(false);
});
