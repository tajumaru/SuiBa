import { backup, DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  chmodSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { acquireInstanceLock } from "./deployment-safety.ts";

const suffixes = [
  "",
  ".pairs.sqlite",
  ".WAL_USDC.sqlite",
  ".chart-history.sqlite",
  ".WAL_USDC.sqlite.chart-history.sqlite",
];
type Entry = {
  name: string;
  sha256: string;
  schemaSha256: string;
  userVersion: number;
};
type Manifest = {
  version: 1;
  mode: "PAPER";
  at: string;
  bootId: string;
  rootName: string;
  databases: Entry[];
};
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
function fileDigest(path: string) {
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    let size: number;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, size));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

function regular(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw Error("UNSAFE_BACKUP_FILE");
}
function inspect(path: string, trading = false) {
  regular(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0].integrity_check !== "ok")
      throw Error("BACKUP_INTEGRITY_FAILED");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw Error("BACKUP_FOREIGN_KEY_FAILED");
    if (trading) {
      const row = db
        .prepare("SELECT json FROM bot_runtime_state WHERE key='runtime'")
        .get();
      if (!row || JSON.parse(String(row.json)).running !== false)
        throw Error("BACKUP_REQUIRES_STOPPED_RUNTIME");
    }
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    const version = db.prepare("PRAGMA user_version").get()!;
    return {
      schemaSha256: digest(JSON.stringify(schema)),
      userVersion: Number(version.user_version),
    };
  } finally {
    db.close();
  }
}

/** Local, plaintext staging only. Off-host encryption and retention are a
 * separate operator step; no network, secret handling or production restore.
 */
export async function createPaperBackup(
  databasePath: string,
  destination: string,
) {
  const lock = acquireInstanceLock(databasePath);
  try {
    regular(lock.root + ".lifecycle.json");
    const receipt = JSON.parse(
      readFileSync(lock.root + ".lifecycle.json", "utf8"),
    );
    if (
      receipt.version !== 1 ||
      receipt.mode !== "PAPER" ||
      receipt.state !== "clean" ||
      typeof receipt.bootId !== "string"
    )
      throw Error("BACKUP_REQUIRES_CLEAN_SHUTDOWN");
    // File presence is deliberate: it prevents an operator restarting the
    // worker into a tradable state while this backup is being reviewed.
    lstatSync(lock.root + ".maintenance");
    const sources: { path: string; trading: boolean }[] = [];
    for (const suffix of suffixes) {
      const path = lock.root + suffix;
      try {
        regular(path);
        sources.push({
          path,
          trading: suffix === "" || suffix === ".WAL_USDC.sqlite",
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (
      !sources.some((s) => s.trading) ||
      !sources.some((s) => s.path.endsWith(".pairs.sqlite"))
    )
      throw Error("BACKUP_DATABASE_SET_INCOMPLETE");
    // A new sibling DB must be explicitly added to the inventory, never silently
    // omitted. Other services/auth/report files need their own inventory first.
    const prefix = basename(lock.root) + ".";
    const names = new Set(sources.map((s) => basename(s.path)));
    for (const name of readdirSync(resolve(lock.root, ".."))) {
      if (
        name.startsWith(prefix) &&
        name.endsWith(".sqlite") &&
        name !== basename(lock.root) + ".instance.sqlite" &&
        !names.has(name)
      )
        throw Error("BACKUP_UNKNOWN_DATABASE");
    }
    for (const source of sources) inspect(source.path, source.trading);
    mkdirSync(destination, { mode: 0o700 }); // no overwrite or partial reuse
    const manifest: Manifest = {
      version: 1,
      mode: "PAPER",
      at: new Date().toISOString(),
      bootId: receipt.bootId,
      rootName: basename(lock.root),
      databases: [],
    };
    for (const source of sources) {
      const name = basename(source.path),
        target = join(destination, name);
      const db = new DatabaseSync(source.path, { readOnly: true });
      try {
        await backup(db, target);
      } finally {
        db.close();
      }
      const snapshot = new DatabaseSync(target);
      try {
        snapshot.exec("PRAGMA journal_mode=DELETE;");
      } finally {
        snapshot.close();
      }
      chmodSync(target, 0o600);
      const schema = inspect(target, source.trading);
      manifest.databases.push({
        name,
        sha256: fileDigest(target),
        ...schema,
      });
    }
    // Written last. Missing/invalid manifest means an incomplete backup.
    writeFileSync(
      join(destination, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    return manifest;
  } finally {
    lock.close();
  }
}

export function verifyPaperBackup(directory: string): Manifest {
  regular(join(directory, "manifest.json"));
  const manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  ) as Manifest;
  const simpleName = (name: unknown): name is string =>
    typeof name === "string" &&
    name.length > 0 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/:\x00]/.test(name);
  if (
    manifest.version !== 1 ||
    manifest.mode !== "PAPER" ||
    !simpleName(manifest.rootName) ||
    !Array.isArray(manifest.databases) ||
    !manifest.databases.length
  )
    throw Error("INVALID_BACKUP_MANIFEST");
  const expected = new Set(suffixes.map((s) => manifest.rootName + s));
  const seen = new Set<string>();
  for (const entry of manifest.databases) {
    if (
      !entry ||
      !simpleName(entry.name) ||
      !expected.has(entry.name) ||
      seen.has(entry.name)
    )
      throw Error("INVALID_BACKUP_MANIFEST");
    seen.add(entry.name);
    const path = join(directory, entry.name);
    regular(path);
    // Snapshots must be standalone; an injected WAL could override hashed data.
    for (const sidecar of ["-wal", "-shm", "-journal"]) {
      try {
        lstatSync(path + sidecar);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw Error("BACKUP_UNEXPECTED_SIDECAR");
    }
    if (fileDigest(path) !== entry.sha256) throw Error("BACKUP_HASH_MISMATCH");
    const info = inspect(
      path,
      entry.name === manifest.rootName ||
        entry.name === manifest.rootName + ".WAL_USDC.sqlite",
    );
    if (
      info.schemaSha256 !== entry.schemaSha256 ||
      info.userVersion !== entry.userVersion
    )
      throw Error("BACKUP_SCHEMA_MISMATCH");
  }
  if (
    !seen.has(manifest.rootName + ".pairs.sqlite") ||
    !(
      seen.has(manifest.rootName) ||
      seen.has(manifest.rootName + ".WAL_USDC.sqlite")
    )
  )
    throw Error("BACKUP_DATABASE_SET_INCOMPLETE");
  return manifest;
}

/** Restore rehearsal into a NEW directory, never in-place against production. */
export function restorePaperBackup(directory: string, destination: string) {
  const manifest = verifyPaperBackup(directory);
  const target = resolve(destination),
    source = resolve(directory);
  if (target === source || target.startsWith(source + sep))
    throw Error("INVALID_RESTORE_DESTINATION");
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(
    join(target, manifest.rootName + ".maintenance"),
    "restore rehearsal; manual verification required\n",
    { flag: "wx", mode: 0o600 },
  );
  for (const entry of manifest.databases) {
    copyFileSync(join(directory, entry.name), join(target, entry.name), 1);
    chmodSync(join(target, entry.name), 0o600);
    if (fileDigest(join(target, entry.name)) !== entry.sha256)
      throw Error("RESTORE_HASH_MISMATCH");
  }
  // No lifecycle receipt/permission to auto-start is restored.
  return manifest;
}
