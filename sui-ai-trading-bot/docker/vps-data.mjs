// Offline data operations only. Never imports or starts the Worker/engine.
import {
  constants,
  openSync,
  closeSync,
  fsyncSync,
  fstatSync,
  writeFileSync,
  lstatSync,
  readdirSync,
  readFileSync,
  cpSync,
} from "node:fs";
import { join, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  acquireInstanceLock,
  recordLifecycle,
} from "../apps/worker/src/deployment-safety.ts";
import {
  existingPaperDatabases,
  assertInitializedPaperState,
} from "../apps/worker/src/paper-database-inventory.ts";
import { BotDatabase } from "../packages/database/src/index.ts";

export function maintenance(root) {
  const fd = openSync(
    root + ".maintenance",
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw Error("UNSAFE_MAINTENANCE_FILE");
    writeFileSync(fd, "deployment\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(root), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function verify(root) {
  const names = existingPaperDatabases(dirname(root), basename(root));
  assertInitializedPaperState(dirname(root), basename(root), names);
  const receipt = JSON.parse(readFileSync(root + ".lifecycle.json", "utf8"));
  if (
    receipt.version !== 1 ||
    receipt.mode !== "PAPER" ||
    receipt.state !== "clean"
  )
    throw Error("VPS_UNCLEAN_SHUTDOWN");
  if (!lstatSync(root + ".maintenance").isFile())
    throw Error("VPS_MAINTENANCE_REQUIRED");
  for (const name of names) {
    const db = new DatabaseSync(join(dirname(root), name), { readOnly: true });
    try {
      const result = db.prepare("PRAGMA integrity_check").all();
      if (
        result.length !== 1 ||
        result[0].integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").all().length
      )
        throw Error("VPS_INTEGRITY_FAILED");
      if (
        name === basename(root) ||
        name === basename(root) + ".WAL_USDC.sqlite"
      ) {
        const row = db
          .prepare("SELECT json FROM bot_runtime_state WHERE key='runtime'")
          .get();
        if (!row || JSON.parse(String(row.json)).running !== false)
          throw Error("VPS_RUNTIME_NOT_STOPPED");
      }
    } finally {
      db.close();
    }
  }
  for (const name of readdirSync(dirname(root))) {
    const stat = lstatSync(join(dirname(root), name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw Error("VPS_UNSAFE_BACKUP_ENTRY");
    if (
      name.endsWith(".sqlite") &&
      name !== basename(root) + ".instance.sqlite" &&
      !names.has(name)
    )
      throw Error("VPS_UNKNOWN_DATABASE");
  }
}

export function initialize(root, confirmation) {
  if (confirmation !== "NEW-PAPER-LEDGER")
    throw Error("VPS_INITIALIZATION_CONFIRMATION_REQUIRED");
  if (
    readdirSync(dirname(root)).some(
      (name) => name !== basename(root) + ".maintenance",
    )
  )
    throw Error("VPS_INITIALIZATION_REQUIRES_EMPTY_VOLUME");
  maintenance(root);
  const lock = acquireInstanceLock(root);
  try {
    for (const suffix of ["", ".WAL_USDC.sqlite", ".pairs.sqlite"]) {
      const db = new BotDatabase(root + suffix);
      try {
        db.set("runtime", { ...db.runtime(), running: false });
        // Persist defaults explicitly for REQUIRE_EXISTING_DATABASE.
        db.set("settings", db.settings());
        db.set("portfolio", db.portfolio());
        if (suffix === ".pairs.sqlite") db.set("selected_pair", "SUI_USDC");
      } finally {
        db.close();
      }
    }
    recordLifecycle(root, "offline-initialization", "clean");
    verify(root);
  } finally {
    lock.close();
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/docker/vps-data.mjs")) {
  const [command, confirmation] = process.argv.slice(2);
  const root = process.env.DATABASE_PATH ?? "/app/data/bot.sqlite";
  if (command === "maintenance") maintenance(root);
  else if (command === "initialize") initialize(root, confirmation);
  else if (command === "verify") {
    const lock = acquireInstanceLock(root);
    try {
      verify(root);
    } finally {
      lock.close();
    }
  } else if (command === "backup") {
    const lock = acquireInstanceLock(root);
    try {
      verify(root);
      // Rehearse SQLite WAL recovery on a disposable copy, never the source.
      const target = "/app/reports/rehearsal";
      cpSync(dirname(root), target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      verify(join(target, basename(root)));
      const result = spawnSync("tar", ["-C", dirname(root), "-cf", "-", "."], {
        stdio: ["ignore", "inherit", "inherit"],
      });
      if (result.error || result.status !== 0)
        throw Error("VPS_ARCHIVE_FAILED");
    } finally {
      lock.close();
    }
  } else throw Error("UNKNOWN_VPS_DATA_COMMAND");
}
