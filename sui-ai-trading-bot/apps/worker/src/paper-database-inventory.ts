import { lstatSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const paperDatabaseSuffixes = [
  "",
  ".pairs.sqlite",
  ".WAL_USDC.sqlite",
  ".chart-history.sqlite",
  ".WAL_USDC.sqlite.chart-history.sqlite",
] as const;

export function requireRegularDatabase(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw Error("UNSAFE_BACKUP_FILE");
}

/** Validate the selection without constructing BotDatabase (which creates tables
 * and defaults). Used for source preflight and restored snapshots alike.
 */
export function assertPaperDatabaseSet(
  directory: string,
  rootName: string,
  names: Set<string>,
) {
  const selectionName = rootName + ".pairs.sqlite";
  if (!names.has(selectionName)) throw Error("BACKUP_DATABASE_SET_INCOMPLETE");
  const path = join(directory, selectionName);
  requireRegularDatabase(path);
  const selection = new DatabaseSync(path, { readOnly: true });
  let pair: unknown;
  try {
    const row = selection
      .prepare("SELECT json FROM bot_runtime_state WHERE key='selected_pair'")
      .get();
    pair = row ? JSON.parse(String(row.json)) : "SUI_USDC";
  } finally {
    selection.close();
  }
  if (pair !== "SUI_USDC" && pair !== "WAL_USDC")
    throw Error("BACKUP_INVALID_SELECTED_PAIR");
  const selectedName =
    rootName + (pair === "WAL_USDC" ? ".WAL_USDC.sqlite" : "");
  if (!names.has(selectedName)) throw Error("BACKUP_SELECTED_DATABASE_MISSING");
  for (const suffix of ["", ".WAL_USDC.sqlite"]) {
    if (
      names.has(rootName + suffix + ".chart-history.sqlite") &&
      !names.has(rootName + suffix)
    )
      throw Error("BACKUP_DATABASE_SET_INCOMPLETE");
  }
}

export function existingPaperDatabases(directory: string, rootName: string) {
  const names = new Set<string>();
  for (const suffix of paperDatabaseSuffixes) {
    const name = rootName + suffix,
      path = join(directory, name);
    try {
      requireRegularDatabase(path);
      names.add(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      for (const sidecar of ["-wal", "-shm", "-journal"]) {
        try {
          lstatSync(path + sidecar);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw missing;
        }
        throw Error("BACKUP_ORPHAN_SIDECAR");
      }
    }
  }
  assertPaperDatabaseSet(directory, rootName, names);
  return names;
}

export function assertInitializedPaperState(
  directory: string,
  rootName: string,
  names: Set<string>,
) {
  for (const name of [rootName, rootName + ".WAL_USDC.sqlite"]) {
    if (!names.has(name)) continue;
    const db = new DatabaseSync(join(directory, name), { readOnly: true });
    try {
      for (const key of ["runtime", "portfolio", "settings"]) {
        const row = db
          .prepare("SELECT json FROM bot_runtime_state WHERE key=?")
          .get(key);
        const value = row && JSON.parse(String(row.json));
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw Error("EXISTING_DATABASE_STATE_INCOMPLETE");
      }
    } catch {
      throw Error("EXISTING_DATABASE_STATE_INCOMPLETE");
    } finally {
      db.close();
    }
  }
}
