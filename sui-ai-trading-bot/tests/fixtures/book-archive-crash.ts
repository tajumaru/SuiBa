import { BotDatabase } from "../../packages/database/src/index.ts";
const [databasePath, archivePath, stage] = process.argv.slice(2);
const db = new BotDatabase(databasePath);
const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
// SQLite invokes this scalar inside the DELETE statement, before the transaction commits.
raw.function("crash_archive", () => process.exit(73));
if (stage === "before-delete")
  raw.exec(
    "CREATE TEMP TRIGGER crash BEFORE DELETE ON book_observations BEGIN SELECT crash_archive(); END;",
  );
if (stage === "after-delete")
  raw.exec(
    "CREATE TEMP TRIGGER crash AFTER DELETE ON book_observations BEGIN SELECT crash_archive(); END;",
  );
db.archiveAndPruneBookHistory(archivePath, { retentionMs: 0, maxRows: 1 }, 10);
process.exit(73);
