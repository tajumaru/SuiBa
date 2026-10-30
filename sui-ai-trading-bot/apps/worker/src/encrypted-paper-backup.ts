import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  paperDatabaseSuffixes,
  requireRegularDatabase,
} from "./paper-database-inventory.ts";
import { verifyPaperBackup } from "./paper-backup.ts";

const magic = Buffer.from("SBPAPER1");
const headerSize = magic.length + 12,
  tagSize = 16,
  maxIndexSize = 65536;
const complete = "SuiBa encrypted PAPER backup v1\n";
type Manifest = ReturnType<typeof verifyPaperBackup>;
type Index = {
  version: 1;
  bundleId: string;
  manifest: Manifest;
  sizes: number[];
};
type Options = { signal?: AbortSignal };

function sync(path: string, directory = false) {
  const fd = openSync(path, directory ? "r" : "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string) {
  if (process.platform !== "win32") {
    sync(path, true);
    sync(dirname(path), true);
  }
}
function canonicalNewPath(path: string) {
  const absolute = resolve(path);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}
function inside(path: string, directory: string) {
  if (process.platform === "win32") {
    path = path.toLowerCase();
    directory = directory.toLowerCase();
  }
  return path === directory || path.startsWith(directory + sep);
}
function readKey(path: string, source: string, destination: string) {
  requireRegularDatabase(path);
  const canonical = realpathSync(path);
  if (inside(canonical, realpathSync(source)) || inside(canonical, destination))
    throw Error("BACKUP_KEY_MUST_BE_SEPARATE");
  const fd = openSync(
    path,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  const key = Buffer.alloc(32);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 32)
      throw Error("INVALID_BACKUP_KEY_FILE");
    if (
      process.platform !== "win32" &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid!())
    )
      throw Error("UNSAFE_BACKUP_KEY_PERMISSIONS");
    if (readSync(fd, key, 0, 32, 0) !== 32 || fstatSync(fd).size !== 32)
      throw Error("INVALID_BACKUP_KEY_FILE");
    return key;
  } catch (error) {
    key.fill(0);
    throw error;
  } finally {
    closeSync(fd);
  }
}

async function seal(
  input: AsyncIterable<Buffer>,
  output: string,
  key: Buffer,
  context: string,
  options: Options,
) {
  const header = Buffer.concat([magic, randomBytes(12)]);
  const cipher = createCipheriv(
    "aes-256-gcm",
    key,
    header.subarray(magic.length),
    { authTagLength: tagSize },
  );
  cipher.setAAD(Buffer.concat([header, Buffer.from(context)]));
  await pipeline(
    Readable.from(input),
    cipher,
    async function* (source) {
      yield header;
      for await (const chunk of source) yield chunk;
      yield cipher.getAuthTag();
    },
    createWriteStream(output, { flags: "wx", mode: 0o600 }),
    options,
  );
  sync(output);
}

async function unseal(
  input: string,
  output: () => Writable,
  key: Buffer,
  context: string,
  expectedSize: number,
  options: Options,
) {
  requireRegularDatabase(input);
  const fd = openSync(input, "r");
  const header = Buffer.alloc(headerSize),
    tag = Buffer.alloc(tagSize);
  let size: number;
  try {
    size = fstatSync(fd).size;
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize <= 0 ||
      size !== headerSize + expectedSize + tagSize
    )
      throw Error("INVALID_ENCRYPTED_BACKUP_SIZE");
    if (
      readSync(fd, header, 0, headerSize, 0) !== headerSize ||
      !header.subarray(0, magic.length).equals(magic) ||
      readSync(fd, tag, 0, tagSize, size - tagSize) !== tagSize
    )
      throw Error("INVALID_ENCRYPTED_BACKUP_HEADER");
  } finally {
    closeSync(fd);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    header.subarray(magic.length),
    { authTagLength: tagSize },
  );
  decipher.setAAD(Buffer.concat([header, Buffer.from(context)]));
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(input, { start: headerSize, end: size - tagSize - 1 }),
      decipher,
      output(),
      options,
    );
  } catch (error) {
    // Preserve operational failures (e.g. ENOSPC/AbortError), sanitize crypto errors.
    if (
      options.signal?.aborted ||
      (error as NodeJS.ErrnoException).code === "ENOSPC"
    )
      throw error;
    throw Error("ENCRYPTED_BACKUP_AUTHENTICATION_FAILED");
  }
}

async function* databaseBytes(
  path: string,
  expectedHash: string,
  expectedSize: number,
) {
  requireRegularDatabase(path);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
    yield bytes;
  }
  if (size !== expectedSize || hash.digest("hex") !== expectedHash)
    throw Error("BACKUP_SOURCE_CHANGED");
}

/** Encrypt only a verified offline snapshot, never a live DB or its key file. */
export async function encryptPaperBackup(
  source: string,
  destination: string,
  keyFile: string,
  options: Options = {},
) {
  options.signal?.throwIfAborted();
  const target = canonicalNewPath(destination);
  if (inside(target, realpathSync(source)))
    throw Error("INVALID_ENCRYPTED_BACKUP_DESTINATION");
  const key = readKey(keyFile, source, target);
  let created = false;
  try {
    const manifest = verifyPaperBackup(source);
    const index: Index = {
      version: 1,
      bundleId: randomBytes(32).toString("hex"),
      manifest,
      sizes: manifest.databases.map(
        (e) => lstatSync(join(source, e.name)).size,
      ),
    };
    const encoded = Buffer.from(JSON.stringify(index));
    if (encoded.length > maxIndexSize)
      throw Error("INVALID_ENCRYPTED_BACKUP_INDEX");
    mkdirSync(target, { mode: 0o700 });
    created = true;
    await seal(
      (async function* () {
        yield encoded;
      })(),
      join(target, "manifest.enc"),
      key,
      "SuiBa/PAPER/manifest/v1",
      options,
    );
    for (const [i, entry] of manifest.databases.entries()) {
      await seal(
        databaseBytes(join(source, entry.name), entry.sha256, index.sizes[i]),
        join(target, `db-${i}.enc`),
        key,
        `SuiBa/PAPER/data/v1/${index.bundleId}/${i}`,
        options,
      );
    }
    options.signal?.throwIfAborted();
    writeFileSync(join(target, "COMPLETE"), complete, {
      flag: "wx",
      mode: 0o600,
    });
    sync(join(target, "COMPLETE"));
    syncDirectory(target);
  } catch (error) {
    if (created) rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}

function checkedIndex(value: unknown): Index {
  const index = value as Index;
  const name = (s: unknown): s is string =>
    typeof s === "string" &&
    s.length > 0 &&
    s !== "." &&
    s !== ".." &&
    !/[\\/:\x00]/.test(s);
  const hex = (s: unknown) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
  if (
    !index ||
    index.version !== 1 ||
    !hex(index.bundleId) ||
    !index.manifest ||
    index.manifest.version !== 1 ||
    index.manifest.mode !== "PAPER" ||
    !name(index.manifest.rootName) ||
    !Array.isArray(index.manifest.databases) ||
    !index.manifest.databases.length ||
    index.manifest.databases.length > paperDatabaseSuffixes.length ||
    !Array.isArray(index.sizes) ||
    index.sizes.length !== index.manifest.databases.length
  )
    throw Error("INVALID_ENCRYPTED_BACKUP_INDEX");
  const allowed = new Set(
    paperDatabaseSuffixes.map((s) => index.manifest.rootName + s),
  );
  const seen = new Set<string>();
  for (const [i, entry] of index.manifest.databases.entries()) {
    if (
      !entry ||
      !name(entry.name) ||
      entry.name === "manifest.json" ||
      !allowed.has(entry.name) ||
      seen.has(entry.name) ||
      !hex(entry.sha256) ||
      !hex(entry.schemaSha256) ||
      !Number.isSafeInteger(index.sizes[i]) ||
      index.sizes[i] <= 0
    )
      throw Error("INVALID_ENCRYPTED_BACKUP_INDEX");
    seen.add(entry.name);
  }
  return index;
}

/** Decrypt to a NEW private, maintenance-locked snapshot directory only. */
export async function decryptPaperBackup(
  source: string,
  destination: string,
  keyFile: string,
  options: Options = {},
) {
  options.signal?.throwIfAborted();
  const target = canonicalNewPath(destination);
  if (inside(target, realpathSync(source)))
    throw Error("INVALID_ENCRYPTED_BACKUP_DESTINATION");
  requireRegularDatabase(join(source, "COMPLETE"));
  if (
    lstatSync(join(source, "COMPLETE")).size !== Buffer.byteLength(complete) ||
    readFileSync(join(source, "COMPLETE"), "utf8") !== complete
  )
    throw Error("ENCRYPTED_BACKUP_INCOMPLETE");
  const key = readKey(keyFile, source, target);
  let created = false;
  try {
    const manifestPath = join(source, "manifest.enc");
    requireRegularDatabase(manifestPath);
    const indexSize = lstatSync(manifestPath).size - headerSize - tagSize;
    if (indexSize <= 0 || indexSize > maxIndexSize)
      throw Error("INVALID_ENCRYPTED_BACKUP_INDEX");
    const chunks: Buffer[] = [];
    await unseal(
      manifestPath,
      () =>
        new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            callback();
          },
        }),
      key,
      "SuiBa/PAPER/manifest/v1",
      indexSize,
      options,
    );
    const index = checkedIndex(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    mkdirSync(target, { mode: 0o700 });
    created = true;
    const gate = join(target, index.manifest.rootName + ".maintenance");
    writeFileSync(gate, "decrypted snapshot; manual verification required\n", {
      flag: "wx",
      mode: 0o600,
    });
    sync(gate);
    for (const [i, entry] of index.manifest.databases.entries()) {
      const partial = join(target, `db-${i}.part`);
      await unseal(
        join(source, `db-${i}.enc`),
        () => createWriteStream(partial, { flags: "wx", mode: 0o600 }),
        key,
        `SuiBa/PAPER/data/v1/${index.bundleId}/${i}`,
        index.sizes[i],
        options,
      );
      sync(partial);
      renameSync(partial, join(target, entry.name)); // No unverified plaintext is published as a DB.
    }
    options.signal?.throwIfAborted();
    const outputManifest = join(target, "manifest.json");
    writeFileSync(
      outputManifest,
      JSON.stringify(index.manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    verifyPaperBackup(target);
    sync(outputManifest);
    syncDirectory(target);
    return index.manifest;
  } catch (error) {
    if (created) rmSync(target, { recursive: true, force: true });
    throw error;
  } finally {
    key.fill(0);
  }
}
