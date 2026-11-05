import { expect, it } from "vitest";
import { readDashboardCssFile } from "./helpers/dashboard-css.ts";

/**
 * Guards for the dashboard stylesheet structure:
 * - recurring palette colours live only as custom properties in
 *   base.css; segment files must reference var(--…) so a colour
 *   cannot drift between files;
 * - the global button finish in terminal.css stays at specificity
 *   0 via :where(), so a bare `button` rule can never again paint
 *   over a class-styled element (the avatar hover incident).
 */
const PALETTE = [
  "#43dfb2",
  "#edc980",
  "#f77d8f",
  "#1f5c46",
  "#dce8f0",
  "#8fa7b9",
  "#8fa3b0",
  "#263448",
  "#344e65",
  "#04070b",
  "#020a06",
  "#0a1a12",
  "#123324",
];
const SEGMENTS = [
  "base",
  "login",
  "panels",
  "overview",
  "vital",
  "narration",
  "strategy",
  "chat",
  "terminal",
  "boot",
  "extras",
];

it("keeps palette hex literals only in base.css variable definitions", () => {
  for (const name of SEGMENTS) {
    const css = readDashboardCssFile(`styles/${name}.css`);
    for (const line of css.split("\n")) {
      for (const hex of PALETTE) {
        if (!line.toLowerCase().includes(hex)) continue;
        expect(
          name === "base" && /^\s*--[a-z-]+:/.test(line),
          `${name}.css hard-codes ${hex}: ${line.trim()}`,
        ).toBe(true);
      }
    }
  }
});

it("keeps the global button finish at zero specificity", () => {
  const css = readDashboardCssFile("styles/terminal.css");
  expect(css).toContain(":where(button) {");
  expect(css).toContain(":where(button:hover) {");
  expect(/(^|\n)button\s*\{/.test(css)).toBe(false);
  expect(/(^|\n)button:hover\s*\{/.test(css)).toBe(false);
});
