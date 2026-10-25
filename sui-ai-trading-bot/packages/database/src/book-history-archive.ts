import { createHash } from "node:crypto";
import {
  constants,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  readFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export interface BookArchiveRow {
  id: string;
  timestamp: number;
  json: string;
}
export interface BookArchive {
  version: 1;
  createdAt: number;
  policy: { retentionMs: number; maxRows: number };
  rows: BookArchiveRow[];
}
export const archiveHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The expected hash must come from the DB receipt or a separately trusted backup manifest. */
export function readVerifiedBookArchive(
  path: string,
  expectedSha256: string,
): BookArchive {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error("INVALID_BOOK_ARCHIVE_HASH");
  const bytes = readFileSync(path);
  if (archiveHash(bytes) !== expectedSha256)
    throw new Error("BOOK_ARCHIVE_VERIFICATION_FAILED");
  const value = JSON.parse(bytes.toString("utf8"));
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !value.policy ||
    ![value.policy.retentionMs, value.policy.maxRows].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    !Array.isArray(value.rows) ||
    !value.rows.length
  )
    throw new Error("INVALID_BOOK_ARCHIVE");
  const ids = new Set<string>();
  for (const row of value.rows) {
    if (
      !row ||
      typeof row.id !== "string" ||
      !row.id.length ||
      ids.has(row.id) ||
      !Number.isSafeInteger(row.timestamp) ||
      row.timestamp < 0 ||
      typeof row.json !== "string"
    )
      throw new Error("INVALID_BOOK_ARCHIVE_ROW");
    const observation = JSON.parse(row.json);
    if (
      !observation ||
      typeof observation !== "object" ||
      Array.isArray(observation)
    )
      throw new Error("INVALID_BOOK_ARCHIVE_ROW");
    ids.add(row.id);
  }
  return value;
}

/** Never grants deletion on unsupported platforms or failed directory synchronization. */
export function persistBookArchive(path: string, archive: BookArchive) {
  const archivePath = resolve(path),
    bytes = Buffer.from(JSON.stringify(archive));
  const fd = openSync(archivePath, "wx");
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const sha256 = archiveHash(bytes);
  readVerifiedBookArchive(archivePath, sha256);
  // Node's fs API does not expose a validated Windows directory-flush primitive.
  // Leave the archive and all DB rows intact; no override or environment escape hatch.
  if (process.platform !== "linux")
    throw new Error("BOOK_ARCHIVE_DIRECTORY_SYNC_UNSUPPORTED");
  const directory = openSync(
    dirname(archivePath),
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return { archivePath, sha256 };
}
