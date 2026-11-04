import { describe, expect, it } from "vitest";
import { readDashboardCssFile } from "./helpers/dashboard-css";

// The avatar's rename tap target is an empty, transparent
// button overlaid on the avatar artwork. The global
// `button:hover` background in terminal.css beats a lone class
// selector on specificity, so without its own hover rule the
// overlay turned opaque on hover and the avatar "vanished"
// under the cursor (reported from the real device, 2026-11-05).
// Guard the see-through hover explicitly.
describe("avatar tap overlay stays transparent", () => {
  it("extras.css pins .agent-avatar-tap:hover to transparent", () => {
    const css = readDashboardCssFile("styles/extras.css");
    expect(css).toMatch(
      /\.agent-avatar-tap:hover\s*\{\s*background:\s*transparent;/,
    );
  });
});
