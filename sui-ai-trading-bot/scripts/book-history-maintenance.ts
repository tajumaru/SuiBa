import { resolve } from "node:path";
import { BotDatabase } from "../packages/database/src/index.ts";
import { assertNodeVersion } from "./verify-node-version.mjs";
assertNodeVersion();
if (process.env.MODE && process.env.MODE !== "PAPER")
  throw new Error("PAPER_ONLY");
const [databasePath, archivePath, days = "0", rows = "0"] =
  process.argv.slice(2);
if (!databasePath || !archivePath)
  throw new Error(
    "USAGE: databasePath archivePath [retentionDays=0] [maxRows=0]",
  );
const retentionDays = Number(days),
  maxRows = Number(rows);
if (!Number.isFinite(retentionDays) || retentionDays < 0)
  throw new Error("INVALID_BOOK_RETENTION");
const db = new BotDatabase(resolve(databasePath));
try {
  console.info(
    JSON.stringify(
      db.archiveAndPruneBookHistory(resolve(archivePath), {
        retentionMs: retentionDays * 86400000,
        maxRows,
      }),
    ),
  );
} finally {
  db.close();
}
