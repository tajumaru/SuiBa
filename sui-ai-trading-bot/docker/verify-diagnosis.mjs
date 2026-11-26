// Fixed, offline diagnostics for a failed verification.
import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { existingPaperDatabases } from "../apps/worker/src/paper-database-inventory.ts";
import { isUnknownDatabase, verify } from "./vps-data.mjs";

export function diagnoseVerify(root) {
  let error = null;
  try {
    verify(root);
  } catch (cause) {
    const token = cause instanceof Error ? cause.message.split(/\s+/, 1)[0] : "";
    if (/^VPS_[A-Z_]+$/.test(token)) error = token;
  }

  let unknown_files = [];
  try {
    const rootName = basename(root);
    const directory = dirname(root);
    const names = existingPaperDatabases(directory, rootName);
    unknown_files = readdirSync(directory)
      .filter((name) =>
        name.length <= 128 && /^[A-Za-z0-9._-]+\.sqlite$/.test(name) &&
        isUnknownDatabase(name, rootName, names),
      )
      .sort()
      .slice(0, 16);
  } catch {
    // The verify error may still be available when the inventory is unreadable.
  }
  return { error, unknown_files };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/docker/verify-diagnosis.mjs")) {
  const root = process.argv[2] ?? process.env.DATABASE_PATH ?? "/app/data/bot.sqlite";
  console.log(JSON.stringify(diagnoseVerify(root)));
}
