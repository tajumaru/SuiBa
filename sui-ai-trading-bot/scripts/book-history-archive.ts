import { resolve } from "node:path";
import { BotDatabase } from "../packages/database/src/index.ts";
import { readVerifiedBookArchive } from "../packages/database/src/book-history-archive.ts";
import { assertNodeVersion } from "./verify-node-version.mjs";
assertNodeVersion();
const [action, path, sha256, databasePath] = process.argv.slice(2);
if (!path || !sha256 || !["verify", "restore"].includes(action))
  throw new Error(
    "USAGE: verify archivePath trustedSha256 | restore archivePath trustedSha256 stoppedDatabasePath",
  );
if (action === "verify") {
  const archive = readVerifiedBookArchive(resolve(path), sha256);
  console.info(
    JSON.stringify({ verified: true, rows: archive.rows.length, sha256 }),
  );
} else {
  if (!databasePath || (process.env.MODE && process.env.MODE !== "PAPER"))
    throw new Error("PAPER_RESTORE_REQUIRES_DATABASE");
  // Validate before opening/initializing any destination database.
  readVerifiedBookArchive(resolve(path), sha256);
  const db = new BotDatabase(resolve(databasePath));
  try {
    console.info(
      JSON.stringify(db.restoreBookHistoryArchive(resolve(path), sha256)),
    );
  } finally {
    db.close();
  }
}
