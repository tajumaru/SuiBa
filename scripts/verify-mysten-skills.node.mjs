import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  cpSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verify, REQUIRED } from "./verify-mysten-skills.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("all seven official skills are pinned, intact and routed for Codex", () => {
  assert.equal(verify(root).skills, 7);
});
test("changed content, unexpected scripts and wrong provenance fail closed", () => {
  const fixture = mkdtempSync(join(tmpdir(), "suiba-skills-"));
  try {
    for (const file of [
      "AGENTS.md",
      "skills-lock.json",
      ".agents/mysten-skills.json",
    ])
      cpSync(join(root, file), join(fixture, file), { recursive: true });
    for (const name of REQUIRED)
      cpSync(
        join(root, ".agents/skills", name),
        join(fixture, ".agents/skills", name),
        { recursive: true },
      );
    assert.equal(verify(fixture).skills, 7);
    const file = join(fixture, ".agents/skills/ptbs/SKILL.md"),
      original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from("\nchanged")]));
    assert.throws(() => verify(fixture), /DIGEST/);
    writeFileSync(file, original);
    const script = join(fixture, ".agents/skills/ptbs/install.sh");
    writeFileSync(script, "echo unapproved");
    assert.throws(() => verify(fixture), /FILE_SET/);
    rmSync(script);
    const manifestFile = join(fixture, ".agents/mysten-skills.json"),
      m = JSON.parse(readFileSync(manifestFile));
    m.source = "https://example.invalid/skills";
    writeFileSync(manifestFile, JSON.stringify(m));
    assert.throws(() => verify(fixture), /UNVERIFIED_SOURCE/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
