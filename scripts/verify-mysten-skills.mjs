import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export const REQUIRED = Object.freeze([
  "deepbook-sdk",
  "deepbook-overview",
  "sui-ts-sdk-backend",
  "sui-sdks",
  "ptbs",
  "sui-client",
  "accessing-data",
]);
export function verify(
  root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
) {
  const manifest = JSON.parse(
    readFileSync(join(root, ".agents/mysten-skills.json"), "utf8"),
  );
  const lock = JSON.parse(readFileSync(join(root, "skills-lock.json"), "utf8"));
  if (
    manifest.source !== "https://github.com/MystenLabs/skills" ||
    !/^[a-f0-9]{40}$/.test(manifest.revision)
  )
    throw Error("UNVERIFIED_SOURCE");
  if (
    Object.keys(manifest.skills).sort().join() !== [...REQUIRED].sort().join()
  )
    throw Error("UNEXPECTED_SKILL_SET");
  const guidance = readFileSync(join(root, "AGENTS.md"), "utf8");
  let fileCount = 0;
  for (const name of REQUIRED) {
    const entry = manifest.skills[name],
      directory = join(root, ".agents/skills", name),
      files = [];
    if (
      entry.path !== `.agents/skills/${name}/SKILL.md` ||
      !guidance.includes("`" + name + "`")
    )
      throw Error("SKILL_NOT_ROUTED");
    function walk(dir) {
      for (const item of readdirSync(dir)) {
        const path = join(dir, item),
          st = lstatSync(path);
        if (st.isSymbolicLink()) throw Error("SKILL_SYMLINK");
        if (st.isDirectory()) walk(path);
        else if (st.isFile())
          files.push({
            path: relative(directory, path).replaceAll("\\", "/"),
            bytes: readFileSync(path),
          });
        else throw Error("UNSUPPORTED_SKILL_FILE");
      }
    }
    walk(directory);
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (
      files
        .map((f) => f.path)
        .sort()
        .join() !== Object.keys(entry.files).sort().join()
    )
      throw Error("SKILL_FILE_SET_MISMATCH");
    const folder = createHash("sha256");
    for (const file of files) {
      if (!/\.(md|json)$/.test(file.path)) throw Error("UNEXPECTED_EXECUTABLE");
      if (
        createHash("sha256").update(file.bytes).digest("hex") !==
        entry.files[file.path]
      )
        throw Error("SKILL_DIGEST_MISMATCH");
      folder.update(file.path);
      folder.update(file.bytes);
      fileCount++;
      if (file.path.endsWith(".json")) JSON.parse(file.bytes.toString("utf8"));
    }
    const skill = files
      .find((f) => f.path === "SKILL.md")
      ?.bytes.toString("utf8");
    if (
      !skill ||
      !new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`).test(skill) ||
      !skill.includes("description:")
    )
      throw Error("INVALID_SKILL_FRONTMATTER");
    for (const match of skill.matchAll(/\*\*Path:\*\* `([^`]+)`/g)) {
      if (!Object.hasOwn(entry.files, match[1]))
        throw Error("MISSING_SKILL_REFERENCE");
    }
    const item = lock.skills[name];
    if (
      item?.source !== "mystenlabs/skills" ||
      item.sourceType !== "github" ||
      item.skillPath !== `${name}/SKILL.md` ||
      item.computedHash !== folder.digest("hex")
    )
      throw Error("SKILL_LOCK_MISMATCH");
  }
  return {
    source: manifest.source,
    revision: manifest.revision,
    skills: REQUIRED.length,
    files: fileCount,
    codexRouting: "AGENTS.md -> .agents/skills",
    networkRequests: 0,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(verify(), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
