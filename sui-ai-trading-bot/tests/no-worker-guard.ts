// Dedicated verification only. Existing full CI and tests are unchanged.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const forbidden = () => {
  throw Error("NO_WORKER_SUBPROCESS_FORBIDDEN");
};
for (const name of [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const) {
  // Reject all child processes from unit-test code, including indirect imports.
  Object.defineProperty(childProcess, name, {
    value: forbidden,
    configurable: true,
    writable: true,
  });
}
syncBuiltinESMExports();
