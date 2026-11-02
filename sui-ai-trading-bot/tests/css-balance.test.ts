import { describe, expect, it } from "vitest";
import {
  dashboardCssFileNames,
  readDashboardCssFile,
} from "./helpers/dashboard-css";

// The dashboard stylesheet is split into per-area files under
// apps/dashboard/src/styles/ (style.css is the @import index).
// A single missing closing brace silently nests — and thereby
// disables — every rule after it in that file (this shipped once:
// the corner-dock and chat-bar blocks were dead on device while
// unit tests and the build stayed green). Guard every file.
describe("dashboard stylesheet brace balance", () => {
  const files = ["style.css", ...dashboardCssFileNames()];
  for (const name of files) {
    it(`${name} never goes negative and ends at zero`, () => {
      const css = readDashboardCssFile(name);
      let depth = 0;
      let inComment = false;
      let inString = false;
      for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        const next = css[i + 1] ?? "";
        if (inComment) {
          if (ch === "*" && next === "/") {
            inComment = false;
            i++;
          }
          continue;
        }
        if (inString) {
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === "/" && next === "*") {
          inComment = true;
          i++;
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
    });
  }
});
