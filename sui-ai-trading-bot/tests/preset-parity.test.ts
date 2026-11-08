import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { defaults } from "../packages/shared/src/index.ts";
import {
  applyHardPreset,
  hardPresetKeys,
} from "../apps/dashboard/src/settingsPresets.ts";

// The VPS paper-check controller carries its own copy of the hard
// preset (deploy/paper-check/controller.py, HARD_PRESET) because it
// swaps the SUI settings host-side while the worker is stopped. The
// two copies must never drift: the dashboard's applyHardPreset is the
// source of truth.
describe("controller HARD_PRESET parity", () => {
  it("matches applyHardPreset key for key", () => {
    const source = readFileSync(
      new URL("../deploy/paper-check/controller.py", import.meta.url),
      "utf8",
    );
    const match = source.match(/HARD_PRESET = \{([\s\S]*?)\n\}/);
    expect(match).not.toBeNull();
    const body = match![1]
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/,\s*$/, "");
    const table = JSON.parse(`{${body}}`) as Record<string, unknown>;
    const hard = applyHardPreset(defaults);
    expect(Object.keys(table).sort()).toEqual([...hardPresetKeys].sort());
    for (const key of hardPresetKeys) expect(table[key]).toBe(hard[key]);
  });
});
