import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export const requiredNodeRange = ">=24.22.1 <25";
export function isSupportedNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major === 24 && (minor > 22 || (minor === 22 && patch >= 1));
}
export function assertNodeVersion({ report = true } = {}) {
  const runtime = {
    version: process.version,
    execPath: process.execPath,
    platform: process.platform,
    arch: process.arch,
  };
  if (!isSupportedNodeVersion(process.versions.node)) {
    console.error(
      JSON.stringify({
        event: "NODE_VERSION_REJECTED",
        required: requiredNodeRange,
        ...runtime,
      }),
    );
    throw new Error("NODE_VERSION_UNSUPPORTED");
  }
  if (report)
    console.log(
      JSON.stringify({
        event: "NODE_VERSION_VERIFIED",
        required: requiredNodeRange,
        ...runtime,
      }),
    );
  return runtime;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  assertNodeVersion();
