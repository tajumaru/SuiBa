import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  unlinkSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  acquireInstanceLock,
  DeploymentGate,
  recordLifecycle,
} from "../apps/worker/src/deployment-safety.ts";

const folders: string[] = [];
function root() {
  const folder = mkdtempSync(join(tmpdir(), "suiba-deploy-"));
  folders.push(folder);
  return join(folder, "bot.sqlite");
}
afterEach(() => {
  for (const path of folders.splice(0))
    rmSync(path, { recursive: true, force: true });
});

it("holds one owner across processes and releases the OS lock after a crash", async () => {
  const path = root();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import {acquireInstanceLock} from "./apps/worker/src/deployment-safety.ts"; const lock=acquireInstanceLock(process.argv[1]); console.log("LOCKED"); setInterval(()=>{},1000);',
      path,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  try {
    const ready = await Promise.race([
      once(child.stdout!, "data").then(([data]) => String(data)),
      exited.then(() => {
        throw Error("LOCK_CHILD_EXITED_EARLY");
      }),
    ]);
    expect(ready).toContain("LOCKED");
    expect(() => acquireInstanceLock(path)).toThrow(
      "INSTANCE_LOCK_UNAVAILABLE",
    );
    // A refused contender must never delete/recreate the lock file.
    expect(() => acquireInstanceLock(path)).toThrow(
      "INSTANCE_LOCK_UNAVAILABLE",
    );
  } finally {
    child.kill("SIGKILL");
    await exited;
  }
  const replacement = acquireInstanceLock(path);
  replacement.close();
}, 15000);

it("does not serialize different DB roots or accept hardlinked trading paths", () => {
  const path = root();
  const first = acquireInstanceLock(path),
    other = acquireInstanceLock(path + ".other");
  other.close();
  first.close();
  writeFileSync(path, "fixture");
  linkSync(path, path + ".alias");
  expect(() => acquireInstanceLock(path)).toThrow("UNSAFE_INSTANCE_PATH");
});

it("keeps maintenance latched after file removal until a new stopped process", () => {
  const path = root(),
    gate = new DeploymentGate(path);
  expect(gate.blocked()).toBe(false);
  writeFileSync(gate.path, "");
  expect(gate.blocked()).toBe(true);
  unlinkSync(gate.path);
  expect(gate.blocked()).toBe(true);
  expect(new DeploymentGate(path).blocked()).toBe(false);
});

it("replaces clean evidence before each boot so an unclean exit cannot inherit it", () => {
  const path = root();
  recordLifecycle(path, "boot-one", "clean");
  recordLifecycle(path, "boot-two", "running");
  expect(
    JSON.parse(readFileSync(path + ".lifecycle.json", "utf8")),
  ).toMatchObject({ mode: "PAPER", bootId: "boot-two", state: "running" });
});
