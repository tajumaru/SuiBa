import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  assertNodeVersion,
  isSupportedNodeVersion,
} from "../scripts/verify-node-version.mjs";
it.each([
  ["24.14.0", false],
  ["24.22.0", false],
  ["24.22.1", true],
  ["24.23.0", true],
  ["25.0.0", false],
  ["23.99.0", false],
  ["24.22.1-rc.1", false],
  ["not-a-version", false],
])("checks Node boundary %s -> %s", (version, expected) => {
  expect(isSupportedNodeVersion(version as string)).toBe(expected);
});
it("reports the interpreter actually executing this test", () => {
  expect(assertNodeVersion({ report: false })).toEqual({
    version: process.version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
  });
  expect(isSupportedNodeVersion(process.versions.node)).toBe(true);
});
it.each(["24.14.0", "25.0.0"])(
  "rejects a simulated unsupported runtime %s before spawning typecheck",
  (version) => {
    const code = `Object.defineProperty(process.versions,"node",{value:${JSON.stringify(version)}}); process.argv=[process.execPath,"scripts/run-project.mjs","typecheck"]; await import("./scripts/run-project.mjs");`;
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", code],
      { encoding: "utf8", windowsHide: true },
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain("NODE_VERSION_REJECTED");
    expect(child.stderr).toContain("NODE_VERSION_UNSUPPORTED");
    expect(child.stdout).not.toContain("NODE_VERSION_VERIFIED");
  },
);
it("keeps source version declarations and package command guards aligned", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.engines.node).toBe(">=24.22.1 <25");
  expect(pkg.packageManager).toBe("pnpm@9.12.3");
  for (const file of [".node-version", ".nvmrc"])
    expect(readFileSync(file, "utf8").trim()).toBe("24.22.1");
  for (const name of [
    "typecheck",
    "build",
    "test",
    "test:offline",
    "test:e2e",
    "dev",
  ])
    expect(pkg.scripts[name]).toBe("node scripts/run-project.mjs " + name);
  expect(readFileSync(".npmrc", "utf8")).toContain("engine-strict=true");
});
