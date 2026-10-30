import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

/** A local-disk ownership lock, separate from the trading databases.
 * Keep the connection alive until process exit (including worker threads).
 * Never unlink this file: doing so would create two independent lock inodes.
 */
export function instanceRoot(databasePath: string) {
  if (databasePath === ":memory:")
    throw Error("INSTANCE_REQUIRES_FILE_DATABASE");
  const absolute = resolve(databasePath);
  mkdirSync(dirname(absolute), { recursive: true });
  const root = join(realpathSync(dirname(absolute)), basename(absolute));
  return root;
}

export function acquireInstanceLock(databasePath: string) {
  const root = instanceRoot(databasePath);
  const lockPath = root + ".instance.sqlite";
  for (const path of [
    root,
    root + ".pairs.sqlite",
    root + ".WAL_USDC.sqlite",
    root + ".chart-history.sqlite",
    root + ".WAL_USDC.sqlite.chart-history.sqlite",
    lockPath,
  ]) {
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error("UNSAFE_INSTANCE_PATH");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const lock = new DatabaseSync(lockPath);
  try {
    lock.exec(
      "PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS instance_guard(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;",
    );
  } catch {
    lock.close();
    throw Error("INSTANCE_LOCK_UNAVAILABLE");
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    process.removeListener("exit", close);
    lock.close();
  };
  // Retain the native connection even if the caller only uses `root` once.
  // Otherwise GC could finalize an unused DatabaseSync while the process lives.
  process.on("exit", close);
  return { root, close };
}

/** File presence or an unreadable path blocks execution. Once observed, the
 * gate remains closed for this process even if the file is removed. Clearing
 * maintenance therefore requires an offline action and a stopped boot.
 */
export class DeploymentGate {
  private latched = false;
  readonly path: string;
  constructor(root: string) {
    this.path = root + ".maintenance";
  }
  blocked() {
    if (this.latched) return true;
    try {
      lstatSync(this.path);
      this.latched = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        this.latched = true;
    }
    return this.latched;
  }
}

export function recordLifecycle(
  root: string,
  bootId: string,
  state: "running" | "clean",
) {
  const target = root + ".lifecycle.json";
  const temp = target + "." + randomUUID();
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(
      fd,
      JSON.stringify({
        version: 1,
        mode: "PAPER",
        bootId,
        state,
        at: Date.now(),
      }) + "\n",
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  if (process.platform !== "win32") {
    const directory = openSync(dirname(target), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
