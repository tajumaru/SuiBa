import { readFileSync } from "node:fs";

// The dashboard stylesheet is split into per-area files under
// apps/dashboard/src/styles/, pulled in by style.css @imports in
// cascade order. Stylesheet assertions read the concatenation in
// import order: the same rule sequence the browser cascades.
export function dashboardCssFileNames(): string[] {
  const index = readFileSync(
    new URL("../../apps/dashboard/src/style.css", import.meta.url),
    "utf8",
  );
  return [...index.matchAll(/@import\s+"\.\/(styles\/[^"]+)";/g)].map(
    (m) => m[1] as string,
  );
}

export function readDashboardCssFile(name: string): string {
  return readFileSync(
    new URL(`../../apps/dashboard/src/${name}`, import.meta.url),
    "utf8",
  );
}

export function readDashboardCss(): string {
  return dashboardCssFileNames()
    .map((name) => readDashboardCssFile(name))
    .join("\n");
}
