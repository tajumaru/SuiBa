// Included only by vitest.no-worker.config.ts, never by the full default suite.
import { expect, it } from "vitest";
import {
  spawn,
  spawnSync,
  exec,
  execSync,
  execFile,
  execFileSync,
  fork,
} from "node:child_process";
import { Socket } from "node:net";

it("rejects every subprocess API before a child can start", () => {
  for (const invoke of [
    () => spawn("forbidden-fixture"),
    () => spawnSync("forbidden-fixture"),
    () => exec("forbidden-fixture"),
    () => execSync("forbidden-fixture"),
    () => execFile("forbidden-fixture"),
    () => execFileSync("forbidden-fixture"),
    () => fork("forbidden-fixture"),
  ])
    expect(invoke).toThrow("NO_WORKER_SUBPROCESS_FORBIDDEN");
});

it("keeps the existing offline network prohibition active", () => {
  expect(() => new Socket().connect(1, "127.0.0.1")).toThrow(
    "OFFLINE_NETWORK_FORBIDDEN",
  );
});
