import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function buildStartupWorker(folder: string) {
  // Use the same TypeScript transformer as the normal tsx entry point.
  const requireFromTsx = createRequire(import.meta.resolve("tsx"));
  const { build } = requireFromTsx("esbuild") as typeof import("esbuild");
  const entry = fileURLToPath(
    new URL("../../apps/worker/src/index.ts", import.meta.url),
  );
  const outfile = join(folder, "startup-worker.mjs");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    plugins: [
      {
        name: "preserve-worker-module-urls",
        setup(build) {
          // Dependencies still load through Node from the workspace.
          build.onResolve({ filter: /^[\w@][^:]*$/ }, ({ path }) => ({
            path: import.meta.resolve(path),
            external: true,
          }));
          // Keep runtime asset and worker-thread paths relative to their sources.
          build.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, "utf8");
            if (!source.includes("import.meta.url")) return;
            return {
              contents: source.replaceAll(
                "import.meta.url",
                JSON.stringify(pathToFileURL(path).href),
              ),
              loader: "ts",
            };
          });
        },
      },
    ],
  });
  return outfile;
}
