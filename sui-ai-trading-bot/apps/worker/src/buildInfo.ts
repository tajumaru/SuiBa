import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * The worker's build identity, shown next to the dashboard's so
 * a version skew between screen and bot is visible at a glance.
 * Resolution order: an explicit SUIBA_BUILD stamp (packaged
 * releases), else the checkout's git HEAD (the worker normally
 * runs from the pulled repo), else "unknown" — which never
 * triggers the skew warning.
 */
export function resolveWorkerBuild(
  env: NodeJS.ProcessEnv = process.env,
  runGit: () => string = defaultGit,
): string {
  const stamped = env.SUIBA_BUILD?.trim();
  if (stamped) return stamped;
  try {
    const out = runGit().trim();
    return out === "" ? "unknown" : out;
  } catch {
    return "unknown";
  }
}

function defaultGit(): string {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  return execSync("git rev-parse --short HEAD", {
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
  });
}

let cached: string | null = null;
export function workerBuild(): string {
  cached ??= resolveWorkerBuild();
  return cached;
}
