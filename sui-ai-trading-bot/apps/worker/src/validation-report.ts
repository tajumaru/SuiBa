import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ValidationReport } from "./validation.ts";
import { validationMarkdown } from "../../../packages/shared/src/validation-presentation.ts";
export { validationMarkdown };
export function exportValidationReport(dir: string, r: ValidationReport) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of [
    ["latest.json", JSON.stringify(r, null, 2) + "\n"],
    ["latest.md", validationMarkdown(r)],
  ]) {
    const file = join(dir, name);
    writeFileSync(file + ".tmp", text, { encoding: "utf8", mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
}
