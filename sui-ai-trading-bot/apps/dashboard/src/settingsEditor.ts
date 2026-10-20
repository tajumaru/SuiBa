import type { Settings } from "../../../packages/shared/src/index.ts";
import { applySafePreset, presetName } from "./settingsPresets.ts";
export type Mode = "safe" | "custom";
export const sameSettings = (a: Settings, b: Settings) =>
  (Object.keys(a) as (keyof Settings)[]).every((key) =>
    Object.is(a[key], b[key]),
  );
export type EditorState = {
  saved: Settings;
  draft: Settings;
  selected: Mode;
  review: boolean;
  switchTo: Mode | null;
  status: "editing" | "saving" | "applied" | "error";
  error: string;
  conflict: boolean;
};
export function createEditor(saved: Settings): EditorState {
  return {
    saved: { ...saved },
    draft: { ...saved },
    selected: presetName(saved),
    review: false,
    switchTo: null,
    status: "editing",
    error: "",
    conflict: false,
  };
}
export type EditorAction =
  | { type: "select"; mode: Mode }
  | { type: "discard-switch" }
  | { type: "cancel-switch" }
  | { type: "restore" }
  | { type: "edit"; draft: Settings }
  | { type: "review" }
  | { type: "cancel-review" }
  | { type: "saving" }
  | { type: "saved"; settings: Settings }
  | { type: "failed"; message: string }
  | { type: "sync"; settings: Settings };
function select(state: EditorState, mode: Mode): EditorState {
  return {
    ...state,
    selected: mode,
    draft: mode === "safe" ? applySafePreset(state.saved) : { ...state.saved },
    review: false,
    switchTo: null,
    status: "editing",
    error: "",
    conflict: false,
  };
}
export function settingsEditor(
  state: EditorState,
  action: EditorAction,
): EditorState {
  if (state.status === "saving" && !["saved", "failed"].includes(action.type))
    return state;
  switch (action.type) {
    case "select":
      if (action.mode === state.selected) return state;
      return !sameSettings(state.draft, state.saved)
        ? {
            ...state,
            switchTo: action.mode,
            review: false,
            status: "editing",
            error: "",
          }
        : select(state, action.mode);
    case "discard-switch":
      return state.switchTo ? select(state, state.switchTo) : state;
    case "cancel-switch":
      return { ...state, switchTo: null };
    case "restore":
      return createEditor(state.saved);
    case "edit":
      return {
        ...state,
        draft: { ...action.draft },
        selected: "custom",
        review: false,
        switchTo: null,
        status: "editing",
        error: state.conflict ? state.error : "",
      };
    case "review":
      return state.conflict
        ? state
        : { ...state, review: true, status: "editing", error: "" };
    case "cancel-review":
      return { ...state, review: false };
    case "saving":
      return state.review && !state.switchTo && !state.conflict
        ? { ...state, status: "saving", error: "" }
        : state;
    case "saved":
      return {
        ...state,
        saved: { ...action.settings },
        draft: { ...action.settings },
        review: false,
        switchTo: null,
        status: "applied",
        error: "",
        conflict: false,
      };
    case "failed":
      return { ...state, status: "error", error: action.message };
    case "sync":
      if (sameSettings(state.saved, action.settings)) return state;
      if (sameSettings(state.draft, state.saved))
        return createEditor(action.settings);
      if (sameSettings(state.draft, action.settings))
        return { ...state, saved: { ...action.settings }, review: false };
      return {
        ...state,
        saved: { ...action.settings },
        review: false,
        conflict: true,
        status: "editing",
        error:
          "別の操作で保存済み設定が更新されました。保存済みに戻してから編集してください。",
      };
  }
}
