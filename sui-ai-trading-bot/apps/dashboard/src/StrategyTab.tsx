import React, { useEffect } from "react";
import type { BotSnapshot } from "../../worker/src/engine.ts";
import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import { saveSettings, type SettingsApi } from "./settingsPresets.ts";
import { StrategyPanel } from "./StrategyPanel.tsx";
import { Party } from "./PartyPanel.tsx";
import {
  SettingsForm,
  StopReleaseSection,
  startBlockedReasons,
  useSettingsEditor,
} from "./SettingsPage.tsx";

type State = BotSnapshot;
export type StrategySegment = "party" | "rules" | "settings";

const SEGMENTS = [
  { id: "party", label: "パーティ" },
  { id: "rules", label: "さくせん" },
  { id: "settings", label: "設定" },
] as const;

/**
 * The strategy tab: the rule diagram and the settings editor are
 * different tools, so they live behind a segment switch instead of
 * one long scroll — さくせん (how the bot decides) and 設定 (the
 * かんたん設定 editor). Both panels stay mounted and are only
 * hidden, like the app's tab panels, so unsaved settings edits
 * survive switching segments. Starting/stopping PAPER operation
 * lives in the operation bar (unified there); what stays on this
 * page is the stop-state release section, rendered above the
 * segment switch in a stopped state only — and the start gate:
 * this tab owns the settings editor, so it reports the editor's
 * start blocks up to the bar, which disables its start button
 * and lists the reasons while this tab is open.
 */
export function StrategyTab({
  data,
  api,
  onSaved,
  control,
  telemetry,
  segment,
  onSegmentChange,
  onStartGateChange,
}: {
  data: State;
  api: SettingsApi;
  onSaved: () => Promise<void>;
  control: (c: string) => Promise<string | null>;
  telemetry: DecisionTelemetry | null;
  segment: StrategySegment;
  onSegmentChange: (segment: StrategySegment) => void;
  onStartGateChange?: (blocked: string[]) => void;
}) {
  const editor = useSettingsEditor(data, api, onSaved);
  // The bar's start gate: report this editor's blocks while the
  // tab is mounted, and clear them on the way out (leaving the tab
  // discards the editor, so its blocks end with it).
  const blocked = startBlockedReasons(editor, data.runtime);
  const blockedKey = blocked.join("\n");
  useEffect(() => {
    onStartGateChange?.(blocked);
    return () => onStartGateChange?.([]);
  }, [blockedKey]);
  return (
    <>
      <StopReleaseSection
        data={data}
        control={control}
        onReviewSettings={(field) => {
          onSegmentChange("settings");
          requestAnimationFrame(() => {
            const input = document.getElementById(`setting-${field}`);
            input?.scrollIntoView({ block: "center" });
            input?.focus({ preventScroll: true });
          });
        }}
      />
      <div
        className="strategy-segments"
        role="tablist"
        aria-label="戦略ページの表示切替"
      >
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={`strategy-segment-${s.id}`}
            aria-selected={segment === s.id}
            aria-controls={`strategy-segment-panel-${s.id}`}
            className={segment === s.id ? "active" : ""}
            onClick={() => onSegmentChange(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="strategy-segment-panel-party"
        aria-labelledby="strategy-segment-party"
        hidden={segment !== "party"}
      >
        <Party
          party={data.party}
          bossHistory={data.bossHistory}
          sageWork={data.sageWork}
          toggles={{
            profitGuardEnabled: data.settings.profitGuardEnabled,
            shadowEnabled: data.settings.shadowEnabled,
            disabled: editor.dirty || editor.busy,
            onToggle: async (key, next) => {
              await saveSettings(api, { ...data.settings, [key]: next });
              await onSaved();
            },
          }}
        />
      </div>
      <div
        role="tabpanel"
        id="strategy-segment-panel-rules"
        aria-labelledby="strategy-segment-rules"
        hidden={segment !== "rules"}
      >
        <StrategyPanel data={data} telemetry={telemetry} />
      </div>
      <div
        role="tabpanel"
        id="strategy-segment-panel-settings"
        aria-labelledby="strategy-segment-settings"
        hidden={segment !== "settings"}
      >
        <SettingsForm editor={editor} />
      </div>
    </>
  );
}
