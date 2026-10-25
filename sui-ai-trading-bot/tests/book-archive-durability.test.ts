import { afterEach, beforeEach, expect, it, vi } from "vitest";
// Yield between synchronous fsync-heavy cases so Vitest can deliver worker updates.
beforeEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});
const fault = vi.hoisted(() => ({ stage: "", steps: [] as string[] }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const checkpoint = (stage: string) => {
    fault.steps.push(stage);
    if (fault.stage === stage) throw new Error(`INJECTED_${stage}`);
  };
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      if (typeof args[1] === "number" && args[1] & fs.constants.O_DIRECTORY)
        checkpoint("directory-open");
      return fs.openSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (typeof args[0] === "number") checkpoint("write");
      if (typeof args[0] === "number" && fault.stage === "partial-write") {
        fs.writeFileSync(args[0], '{"version":');
        throw new Error("INJECTED_partial-write");
      }
      return fs.writeFileSync(...args);
    },
    fsyncSync: (fd: number) => {
      checkpoint(
        fs.fstatSync(fd).isDirectory() ? "directory-sync" : "file-sync",
      );
      fs.fsyncSync(fd);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (String(args[0]).endsWith("archive.json")) {
        checkpoint("verify-read");
        if (fault.stage === "corrupt") return Buffer.from("corrupt");
      }
      return fs.readFileSync(...args);
    },
  };
});
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  archiveHash,
  readVerifiedBookArchive,
} from "../packages/database/src/book-history-archive.ts";
const databases: BotDatabase[] = [],
  folders: string[] = [];
afterEach(() => {
  fault.stage = "";
  fault.steps = [];
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const path of folders.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "suiba-archive-durability-"));
  folders.push(folder);
  const databasePath = join(folder, "bot.sqlite"),
    path = join(folder, "archive.json");
  const db = new BotDatabase(databasePath);
  databases.push(db);
  for (let i = 1; i <= 3; i++)
    db.append(
      "book_observations",
      `b${i}`,
      { observedAt: i, healthy: false, book: null },
      i,
    );
  fault.steps = [];
  return { db, folder, path, databasePath };
}
function unchanged(db: BotDatabase) {
  expect(db.history("book_observations")).toHaveLength(3);
  expect(db.history("book_history_archives")).toHaveLength(0);
}
it.runIf(process.platform !== "linux")(
  "refuses pruning without a supported directory flush, preserving an inspectable archive",
  () => {
    const { db, path } = fixture();
    expect(() =>
      db.archiveAndPruneBookHistory(path, { retentionMs: 0, maxRows: 1 }, 10),
    ).toThrow("DIRECTORY_SYNC_UNSUPPORTED");
    unchanged(db);
    expect(JSON.parse(readFileSync(path, "utf8")).rows).toHaveLength(2);
  },
);
it.each(["write", "partial-write", "file-sync", "verify-read", "corrupt"])(
  "preserves all DB rows at archive failure: %s",
  (stage) => {
    const { db, path } = fixture();
    fault.stage = stage;
    expect(() =>
      db.archiveAndPruneBookHistory(path, { retentionMs: 0, maxRows: 1 }, 10),
    ).toThrow();
    unchanged(db);
  },
);
it
  .runIf(process.platform === "linux")
  .each(["directory-open", "directory-sync"])(
  "preserves all DB rows at directory failure: %s",
  (stage) => {
    const { db, path } = fixture();
    fault.stage = stage;
    expect(() =>
      db.archiveAndPruneBookHistory(path, { retentionMs: 0, maxRows: 1 }, 10),
    ).toThrow(`INJECTED_${stage}`);
    unchanged(db);
  },
);
it.runIf(process.platform === "linux")(
  "orders persistence before DELETE and rolls back a real COMMIT failure; retry never overwrites",
  () => {
    const { db, path, folder } = fixture();
    const raw = (db as unknown as { db: DatabaseSync }).db;
    raw.function("assert_archive_synced", () => {
      expect(fault.steps.at(-1)).toBe("directory-sync");
      return 1;
    });
    raw.exec(
      "CREATE TEMP TRIGGER assert_before_delete BEFORE DELETE ON book_observations BEGIN SELECT assert_archive_synced(); END;",
    );
    raw.exec(`CREATE TABLE parent(id INTEGER PRIMARY KEY);
    CREATE TABLE child(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER fail_archive_commit AFTER INSERT ON book_history_archives BEGIN INSERT INTO child VALUES(99); END;`);
    // The receipt INSERT follows DELETE; observe it only after directory-sync.
    const append = db.append.bind(db);
    vi.spyOn(db, "append").mockImplementation((...args) => {
      if (args[0] === "book_history_archives") {
        expect(fault.steps).toEqual([
          "write",
          "file-sync",
          "verify-read",
          "directory-open",
          "directory-sync",
        ]);
        expect(
          raw.prepare("SELECT count(*) AS n FROM book_observations").get()!.n,
        ).toBe(1);
      }
      return append(...args);
    });
    expect(() =>
      db.archiveAndPruneBookHistory(path, { retentionMs: 0, maxRows: 1 }, 10),
    ).toThrow();
    unchanged(db);
    expect(raw.prepare("SELECT * FROM child").all()).toHaveLength(0);
    expect(() =>
      db.archiveAndPruneBookHistory(path, { retentionMs: 0, maxRows: 1 }, 10),
    ).toThrow();
    unchanged(db);
    raw.exec("DROP TRIGGER fail_archive_commit");
    fault.steps = [];
    const receipt = db.archiveAndPruneBookHistory(
      join(folder, "retry-archive.json"),
      { retentionMs: 0, maxRows: 1 },
      11,
    );
    expect(receipt.deleted).toBe(2);
  },
);
it("verifies trusted hashes and restores exact rows idempotently; conflicts roll back", () => {
  const { db, path } = fixture();
  const rows = [
    {
      id: "new",
      timestamp: 0,
      json: JSON.stringify({ observedAt: 0, healthy: false, book: null }),
    },
    {
      id: "b1",
      timestamp: 1,
      json: JSON.stringify({ observedAt: 1, healthy: false, book: null }),
    },
  ];
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      createdAt: 10,
      policy: { retentionMs: 0, maxRows: 1 },
      rows,
    }),
  );
  writeFileSync(path, bytes);
  const hash = archiveHash(bytes);
  expect(readVerifiedBookArchive(path, hash).rows).toHaveLength(2);
  expect(() => readVerifiedBookArchive(path, "0".repeat(64))).toThrow(
    "VERIFICATION_FAILED",
  );
  const raw = (db as unknown as { db: DatabaseSync }).db;
  raw.prepare("UPDATE book_observations SET json='{}' WHERE id='b1'").run();
  expect(() => db.restoreBookHistoryArchive(path, hash)).toThrow(
    "RESTORE_CONFLICT",
  );
  expect(db.history("book_observations")).toHaveLength(3);
  raw
    .prepare("UPDATE book_observations SET json=? WHERE id='b1'")
    .run(rows[1].json);
  expect(db.restoreBookHistoryArchive(path, hash)).toEqual({
    restored: 1,
    alreadyPresent: 1,
  });
  expect(db.restoreBookHistoryArchive(path, hash)).toEqual({
    restored: 0,
    alreadyPresent: 2,
  });
  db.set("paper_safety", { resumePending: true });
  expect(() => db.restoreBookHistoryArchive(path, hash)).toThrow(
    "REQUIRES_STOP",
  );
  expect(() =>
    db.archiveAndPruneBookHistory(
      path + ".new",
      { retentionMs: 0, maxRows: 1 },
      10,
    ),
  ).toThrow("REQUIRES_STOP");
});
it.each(["duplicate", "invalid-json", "bad-version"])(
  "rejects malformed archives even with a matching hash: %s",
  (kind) => {
    const { path } = fixture();
    const row = {
      id: "x",
      timestamp: 1,
      json: kind === "invalid-json" ? "null" : "{}",
    };
    const bytes = Buffer.from(
      JSON.stringify({
        version: kind === "bad-version" ? 2 : 1,
        createdAt: 10,
        policy: { retentionMs: 0, maxRows: 1 },
        rows: kind === "duplicate" ? [row, row] : [row],
      }),
    );
    writeFileSync(path, bytes);
    expect(() => readVerifiedBookArchive(path, archiveHash(bytes))).toThrow();
  },
);

it("runs the verification and restore CLI and rejects a wrong hash before creating its destination", () => {
  const { path, folder } = fixture();
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      createdAt: 10,
      policy: { retentionMs: 0, maxRows: 1 },
      rows: [{ id: "cli", timestamp: 1, json: "{}" }],
    }),
  );
  writeFileSync(path, bytes);
  const sha = archiveHash(bytes),
    destination = join(folder, "restored.sqlite");
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/book-history-archive.ts", ...args],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, MODE: "PAPER" },
      },
    );
  const verified = run("verify", path, sha);
  expect(verified.status, verified.stderr).toBe(0);
  expect(verified.stdout).toContain('"verified":true');
  const bad = run("restore", path, "0".repeat(64), destination);
  expect(bad.status).not.toBe(0);
  // Opening the target readonly fails if the bad-hash command created no DB.
  expect(() => new DatabaseSync(destination, { readOnly: true })).toThrow();
  const restored = run("restore", path, sha, destination);
  expect(restored.status, restored.stderr).toBe(0);
  expect(restored.stdout).toContain('"restored":1');
  const again = run("restore", path, sha, destination);
  expect(again.status, again.stderr).toBe(0);
  expect(again.stdout).toContain('"alreadyPresent":1');
}, 30000); // Four fresh Node/tsx processes plus real SQLite fsync, including on slower CI disks.

// Abrupt process termination models loss of uncommitted DB work, NOT physical cache/power loss.
it
  .runIf(process.platform === "linux")
  .each(["before-delete", "after-delete", "after-commit"])(
  "recovers consistently after process termination: %s",
  (stage) => {
    const { db, path, databasePath } = fixture();
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "tests/fixtures/book-archive-crash.ts",
        databasePath,
        path,
        stage,
      ],
      { encoding: "utf8", windowsHide: true },
    );
    expect(result.status, result.stderr).toBe(73);
    const receipt = db.history<{ sha256: string }>("book_history_archives")[0];
    if (stage === "after-commit") {
      expect(db.history("book_observations")).toHaveLength(1);
      expect(readVerifiedBookArchive(path, receipt.sha256).rows).toHaveLength(
        2,
      );
    } else unchanged(db);
  },
);
