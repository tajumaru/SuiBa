import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { plan, buildBlueprint } from "./sessions.mjs";
export function parseArgs(argv) {
  const keys = {
    "--action": "action",
    "--network": "network",
    "--owner": "owner",
    "--session": "session",
    "--duration-ms": "durationMs",
  };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = keys[argv[i]];
    if (
      !key ||
      Object.hasOwn(options, key) ||
      !argv[i + 1] ||
      argv[i + 1].startsWith("--")
    )
      throw Error("UNKNOWN_OR_MISSING_ARGUMENT");
    options[key] = argv[++i];
  }
  return options;
}
export function run(argv) {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 22 || (minor === 22 && patch < 1))
    throw Error("NODE_VERSION_UNSUPPORTED");
  const options = parseArgs(argv);
  if (Object.keys(options).length === 0) return plan();
  return buildBlueprint(options);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2)), null, 2));
  } catch (e) {
    console.error(/^[A-Z_]+$/.test(e.message) ? e.message : "POC_FAILED");
    process.exitCode = 1;
  }
}
