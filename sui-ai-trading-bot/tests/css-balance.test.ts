import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The dashboard stylesheet grows by appended override blocks.
// A single missing closing brace silently nests — and thereby
// disables — every rule after it (this shipped once: the
// corner-dock and chat-bar blocks were dead on device while
// unit tests and the build stayed green). Guard the balance.
describe("style.css brace balance", () => {
  it("never goes negative and ends at zero", () => {
    const css = readFileSync(
      new URL("../apps/dashboard/src/style.css", import.meta.url),
      "utf8",
    );
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
});
