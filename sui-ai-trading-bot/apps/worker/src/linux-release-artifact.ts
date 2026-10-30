import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep, isAbsolute } from "node:path";
import { assertNodeVersion } from "../../../scripts/verify-node-version.mjs";

export const databaseContract = "suiba-paper-json-v1";
const payload = [
  "apps",
  "packages",
  "scripts",
  "node_modules",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "tsconfig.json",
];
type Entry = { path: string; hash: string; link?: string };
export type ReleaseManifest = {
  version: 1;
  mode: "PAPER";
  sha: string;
  platform: "linux";
  arch: string;
  node: string;
  databaseContract: string;
  files: Entry[];
};
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function fileHash(path: string) {
  const hash = createHash("sha256"),
    buffer = Buffer.alloc(1024 * 1024),
    fd = openSync(path, "r");
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
export function revision(value: string) {
  if (!/^[a-f0-9]{40}$/.test(value)) throw Error("INVALID_RELEASE_SHA");
  return value;
}
function ownership(path: string, required: boolean) {
  const stat = lstatSync(path);
  if ((stat.mode & 0o7000) !== 0) throw Error("RELEASE_SPECIAL_PERMISSIONS");
  if (
    required &&
    (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0))
  )
    throw Error("RELEASE_NOT_IMMUTABLE");
  return stat;
}
function entries(root: string, rootOwned: boolean): Entry[] {
  const result: Entry[] = [],
    canonical = realpathSync(root);
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      if (folder === root && name === "release.json") continue;
      if (
        name === ".env" ||
        name.startsWith(".env.") ||
        [".git", ".aws", ".test-tmp"].includes(name)
      )
        throw Error("RELEASE_PRIVATE_FILE");
      const path = join(folder, name),
        stat = ownership(path, rootOwned);
      const rel = relative(root, path).split(sep).join("/");
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path),
          actual = realpathSync(path);
        if (isAbsolute(link) || !actual.startsWith(canonical + sep))
          throw Error("RELEASE_EXTERNAL_LINK");
        result.push({ path: rel, link, hash: sha256(link) });
      } else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) result.push({ path: rel, hash: fileHash(path) });
      else throw Error("RELEASE_SPECIAL_FILE");
    }
  };
  for (const name of readdirSync(root))
    if (name !== "release.json" && !payload.includes(name))
      throw Error("RELEASE_UNEXPECTED_PATH");
  ownership(root, rootOwned);
  walk(root);
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
export function verifyLinuxRelease(
  root: string,
  sha: string,
  rootOwned = false,
): ReleaseManifest {
  revision(sha);
  assertNodeVersion({ report: false });
  const stat = ownership(root, rootOwned);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("INVALID_RELEASE_DIRECTORY");
  const manifestPath = join(root, "release.json"),
    manifestStat = ownership(manifestPath, rootOwned);
  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 16 * 1024 * 1024
  )
    throw Error("INVALID_RELEASE_MANIFEST");
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as ReleaseManifest;
  if (
    manifest.version !== 1 ||
    manifest.mode !== "PAPER" ||
    manifest.sha !== sha ||
    manifest.platform !== "linux" ||
    manifest.arch !== process.arch ||
    manifest.node !== process.version ||
    manifest.databaseContract !== databaseContract ||
    !Array.isArray(manifest.files)
  )
    throw Error("INCOMPATIBLE_RELEASE");
  const actual = entries(root, rootOwned);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    throw Error("RELEASE_CONTENT_CHANGED");
  for (const required of [
    "apps/worker/src/index.ts",
    "scripts/enforce-node-version.mjs",
    "pnpm-lock.yaml",
    "node_modules/tsx/package.json",
  ]) {
    // tsx/package.json may be reached through a manifest-covered internal link.
    if (
      !realpathSync(join(root, required)).startsWith(realpathSync(root) + sep)
    )
      throw Error("RELEASE_REQUIRED_FILE_MISSING");
  }
  return manifest;
}
/** Run on Linux CI against a frozen-lockfile install, never on the VPS. */
export function packageLinuxRelease(
  source: string,
  destination: string,
  sha: string,
) {
  if (process.platform !== "linux") throw Error("LINUX_RELEASE_REQUIRED");
  revision(sha);
  assertNodeVersion({ report: false });
  const src = realpathSync(source),
    target = resolve(destination);
  if (target === src || target.startsWith(src + sep))
    throw Error("INVALID_RELEASE_DESTINATION");
  mkdirSync(target, { mode: 0o755 });
  for (const name of payload)
    cpSync(join(src, name), join(target, name), {
      recursive: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  const manifest: ReleaseManifest = {
    version: 1,
    mode: "PAPER",
    sha,
    platform: "linux",
    arch: process.arch,
    node: process.version,
    databaseContract,
    files: entries(target, false),
  };
  writeFileSync(
    join(target, "release.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o644 },
  );
  verifyLinuxRelease(target, sha);
  return manifest;
}
