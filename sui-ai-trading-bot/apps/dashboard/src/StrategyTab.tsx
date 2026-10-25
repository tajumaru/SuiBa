import React from "react";
import type { BotEngine } from "../../worker/src/engine.ts";
import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import type { IndicatorPoint } from "./strategyView.ts";
import type { SettingsApi } from "./settingsPresets.ts";
import { StrategyPanel } from "./StrategyPanel.tsx";
import {
  PaperOperationControls,
  SettingsForm,
  useSettingsEditor,
} from "./SettingsPage.tsx";

type State = ReturnType<BotEngine["snapshot"]>;
export type StrategySegment = "rules" | "settings";

const SEGMENTS = [
  { id: "rules", label: "ルール" },
  { id: "settings", label: "設定" },
] as const;

/**
 * The strategy tab: the rule diagram and the settings editor are
 * different tools, so they live behind a segment switch instead of
 * one long scroll — ルール (how the bot decides) and 設定 (the
 * かんたん設定 editor). Both panels stay mounted and are only
 * hidden, like the app's tab panels, so unsaved settings edits
 * survive switching segments. Starting/stopping PAPER operation
 * and releasing a stopped state are safety operations, not part of
 * either segment: they render below the panels, always visible.
 */
export function StrategyTab({
  data,
  api,
  onSaved,
  control,
  telemetry,
  history,
  segment,
  onSegmentChange,
}: {
  data: State;
  api: SettingsApi;
  onSaved: () => Promise<void>;
  control: (c: string) => Promise<string | null>;
  telemetry: DecisionTelemetry | null;
  history: IndicatorPoint[];
  segment: StrategySegment;
  onSegmentChange: (segment: StrategySegment) => void;
}) {
  const editor = useSettingsEditor(data, api, onSaved);
  return (
    <>
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
        id="strategy-segment-panel-rules"
        aria-labelledby="strategy-segment-rules"
        hidden={segment !== "rules"}
      >
        <StrategyPanel data={data} telemetry={telemetry} history={history} />
      </div>
      <div
        role="tabpanel"
        id="strategy-segment-panel-settings"
        aria-labelledby="strategy-segment-settings"
        hidden={segment !== "settings"}
      >
        <SettingsForm editor={editor} />
      </div>
      <PaperOperationControls data={data} editor={editor} control={control} />
    </>
  );
}
