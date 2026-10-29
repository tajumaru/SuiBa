import { describe, it, expect } from "vitest";
import { defaults } from "../packages/shared/src/index.ts";
import {
  createEditor,
  settingsEditor,
  sameSettings,
} from "../apps/dashboard/src/settingsEditor.ts";
import {
  applyHardPreset,
  applySafePreset,
} from "../apps/dashboard/src/settingsPresets.ts";

describe("Settings 1.1 editor state", () => {
  it("does not change persisted custom settings on initial display or preset selection", () => {
    const saved = {
      ...defaults,
      dailyLossPct: 0.002,
      stopLossPct: 0.017,
      maxHoldingRatio: 0.08,
      maxSlippage: 0.001,
    };
    const initial = createEditor(saved);
    const selected = settingsEditor(initial, { type: "select", mode: "safe" });
    expect(saved).toEqual(initial.saved);
    expect(selected.saved).toEqual(saved);
    expect(selected.draft).toEqual(applySafePreset(saved));
    expect(selected.draft).toMatchObject({
      maxOrder: 2,
      dailyBuyLimit: 10,
      minNetProfitPct: 0.015,
      dailyLossPct: 0.002,
      stopLossPct: 0.017,
      maxHoldingRatio: 0.08,
      maxSlippage: 0.001,
    });
    expect(selected.review).toBe(false);
    expect(selected.status).toBe("editing");
  });
  it("requires confirmation and discards unsaved values only after explicit mode-switch confirmation", () => {
    let editor = createEditor(defaults);
    editor = settingsEditor(editor, {
      type: "edit",
      draft: { ...defaults, gasUsdc: 0.08 },
    });
    const requested = settingsEditor(editor, { type: "select", mode: "safe" });
    expect(requested.switchTo).toBe("safe");
    expect(requested.draft.gasUsdc).toBe(0.08);
    expect(settingsEditor(requested, { type: "cancel-switch" }).draft).toEqual(
      editor.draft,
    );
    const switched = settingsEditor(requested, { type: "discard-switch" });
    expect(switched.draft.gasUsdc).toBe(defaults.gasUsdc);
    expect(switched.selected).toBe("safe");
    expect(switched.saved).toEqual(defaults);
  });
  it("custom selection returns to saved values after confirming a preset preview discard", () => {
    const safe = settingsEditor(createEditor(defaults), {
      type: "select",
      mode: "safe",
    });
    const requested = settingsEditor(safe, { type: "select", mode: "custom" });
    expect(requested.draft.maxOrder).toBe(2);
    const custom = settingsEditor(requested, { type: "discard-switch" });
    expect(custom.draft).toEqual(defaults);
    expect(custom.selected).toBe("custom");
  });
  it("editing an advanced field updates the selected mode and invalidates review", () => {
    let editor = settingsEditor(createEditor(defaults), {
      type: "select",
      mode: "safe",
    });
    editor = settingsEditor(editor, { type: "review" });
    editor = settingsEditor(editor, {
      type: "edit",
      draft: { ...editor.draft, gasUsdc: 0.06 },
    });
    expect(editor.selected).toBe("custom");
    expect(editor.review).toBe(false);
    expect(editor.saved).toEqual(defaults);
  });
  it("does not enter saving without review, and only records applied after successful save", () => {
    let editor = settingsEditor(createEditor(defaults), {
      type: "select",
      mode: "safe",
    });
    expect(settingsEditor(editor, { type: "saving" }).status).toBe("editing");
    editor = settingsEditor(editor, { type: "review" });
    editor = settingsEditor(editor, { type: "saving" });
    expect(editor.status).toBe("saving");
    expect(settingsEditor(editor, { type: "select", mode: "custom" })).toBe(
      editor,
    );
    const failed = settingsEditor(editor, {
      type: "failed",
      message: "保存失敗",
    });
    expect(failed.status).toBe("error");
    expect(failed.saved).toEqual(defaults);
    const saved = settingsEditor(editor, {
      type: "saved",
      settings: editor.draft,
    });
    expect(saved.status).toBe("applied");
    expect(saved.saved).toEqual(applySafePreset(defaults));
    expect(sameSettings(saved.draft, saved.saved)).toBe(true);
  });
  it("clears applied status on edits and handles an empty numeric input as unsaved", () => {
    let editor = createEditor(defaults);
    editor = settingsEditor(editor, { type: "saved", settings: defaults });
    editor = settingsEditor(editor, {
      type: "edit",
      draft: { ...defaults, maxOrder: NaN },
    });
    expect(editor.status).toBe("editing");
    expect(sameSettings(editor.saved, editor.draft)).toBe(false);
    expect(settingsEditor(editor, { type: "restore" }).draft).toEqual(defaults);
  });
  it("preserves edits but blocks review when a remote settings change conflicts", () => {
    let editor = settingsEditor(createEditor(defaults), {
      type: "select",
      mode: "safe",
    });
    editor = settingsEditor(editor, {
      type: "sync",
      settings: { ...defaults, maxOrder: 1 },
    });
    expect(editor.conflict).toBe(true);
    expect(editor.draft.maxOrder).toBe(2);
    expect(editor.saved.maxOrder).toBe(1);
    expect(settingsEditor(editor, { type: "review" }).review).toBe(false);
    expect(settingsEditor(editor, { type: "restore" }).draft.maxOrder).toBe(1);
  });
  it("refreshes pristine values but never claims application on a polling response", () => {
    const editor = settingsEditor(createEditor(defaults), {
      type: "sync",
      settings: applySafePreset(defaults),
    });
    expect(editor.draft.maxOrder).toBe(2);
    expect(editor.status).toBe("editing");
  });
});

describe("hard mode selection", () => {
  it("selecting hard fills the draft from the hard preset", () => {
    const saved = { ...defaults, oversold: 30, takeProfitPct: 0.04 };
    const initial = createEditor(saved);
    const selected = settingsEditor(initial, { type: "select", mode: "hard" });
    expect(selected.selected).toBe("hard");
    expect(selected.draft).toEqual(applyHardPreset(saved));
  });
});
