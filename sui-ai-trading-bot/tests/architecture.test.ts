import { it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, extname } from "node:path";
function sources(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "dist" || e.name === "node_modules"
        ? []
        : sources(resolve(folder, e.name))
      : [".ts", ".tsx"].includes(extname(e.name))
        ? [resolve(folder, e.name)]
        : [],
  );
}
it("has no circular source imports or transaction execution/signing entrypoints", () => {
  const files = [...sources(resolve("apps")), ...sources(resolve("packages"))],
    all = new Set(files),
    graph = new Map<string, string[]>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    expect(content, file).not.toMatch(
      /@mysten\/sui\/keypairs|\.executeTransaction\s*\(|\.signAndExecute\w*\s*\(|\.fastRouterSwap\s*\(|fromSecretKey\s*\(|fromMnemonic\s*\(|new Transaction\s*\(/,
    );
    graph.set(
      file,
      [...content.matchAll(/from\s+["']([^"']+)["']/g)]
        .map((m) => resolve(dirname(file), m[1]))
        .filter((p) => all.has(p)),
    );
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(file: string) {
    if (active.has(file)) throw new Error("Circular import: " + file);
    if (visited.has(file)) return;
    active.add(file);
    for (const dep of graph.get(file) ?? []) visit(dep);
    active.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
});
