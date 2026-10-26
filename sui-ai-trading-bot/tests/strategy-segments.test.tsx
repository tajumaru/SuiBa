import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaults } from "../packages/shared/src/index.ts";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import { StrategyTab } from "../apps/dashboard/src/StrategyTab.tsx";

type State = ReturnType<BotEngine["snapshot"]>;

const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");
const strategyTab = readFileSync(
  resolve("apps/dashboard/src/StrategyTab.tsx"),
  "utf8",
);

const data = {
  settings: defaults,
  decision: null,
  profitGuard: null,
  acquisitionCostUsdc: null,
  acquisitionFees: null,
  portfolio: { sui: 0, usdc: 100, costBasis: 0 },
  price: 2.412,
  runtime: { running: false, emergency: true, error: null },
} as unknown as State;

function render(segment: "rules" | "settings") {
  return renderToStaticMarkup(
    <StrategyTab
      data={data}
      api={vi.fn()}
      onSaved={async () => {}}
      control={async () => null}
      telemetry={null}
      history={[]}
      segment={segment}
      onSegmentChange={() => {}}
    />,
  );
}

// The rendered regions of the strategy tab, sliced at the region
// boundaries: the stop-state release section at the top of the
// page (start/stop themselves live in the operation bar), then
// the segment switch, then the rules and settings panels.
function regions(html: string) {
  const operationsAt = html.indexOf('class="stop-release"');
  const tablistAt = html.indexOf('role="tablist"');
  const rulesAt = html.indexOf('id="strategy-segment-panel-rules"');
  const settingsAt = html.indexOf('id="strategy-segment-panel-settings"');
  return {
    operations: html.slice(operationsAt, tablistAt),
    rules: html.slice(rulesAt, settingsAt),
    settings: html.slice(settingsAt),
  };
}

// The opening tag of a segment panel, which carries its `hidden`
// state (the panel contents mention aria-hidden elsewhere, so only
// the tag itself is a reliable witness).
function panelTag(html: string, id: string) {
  const at = html.indexOf(`id="${id}"`);
  return html.slice(html.lastIndexOf("<div", at), html.indexOf(">", at) + 1);
}

describe("strategy tab segments", () => {
  it("offers a ルール / 設定 tablist with the open segment selected", () => {
    const html = render("rules");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="戦略ページの表示切替"');
    const rulesTab = html.slice(
      html.indexOf('id="strategy-segment-rules"'),
      html.indexOf('id="strategy-segment-settings"'),
    );
    expect(rulesTab).toContain('aria-selected="true"');
    expect(rulesTab).toContain('aria-controls="strategy-segment-panel-rules"');
    const settingsTab = html.slice(
      html.indexOf('id="strategy-segment-settings"'),
    );
    expect(settingsTab.slice(0, settingsTab.indexOf(">"))).toContain(
      'aria-selected="false"',
    );
    expect(settingsTab).toContain(
      'aria-controls="strategy-segment-panel-settings"',
    );
    expect(html).toContain("ルールベース戦略 — どう判定するか");
    expect(regions(html).settings).toContain("かんたん設定");
  });

  it("defaults to ルール: the settings panel stays mounted but hidden", () => {
    const html = render("rules");
    // The editor is in the DOM (mounted, so its state survives),
    // inside the settings panel, and only that panel is hidden.
    expect(panelTag(html, "strategy-segment-panel-settings")).toContain(
      'hidden=""',
    );
    expect(panelTag(html, "strategy-segment-panel-rules")).not.toContain(
      "hidden",
    );
  });

  it("shows the settings panel and hides the rules panel on 設定", () => {
    const html = render("settings");
    expect(panelTag(html, "strategy-segment-panel-settings")).not.toContain(
      "hidden",
    );
    expect(panelTag(html, "strategy-segment-panel-rules")).toContain(
      'hidden=""',
    );
    const rulesTab = html.slice(
      html.indexOf('id="strategy-segment-rules"'),
      html.indexOf('id="strategy-segment-settings"'),
    );
    expect(rulesTab).toContain('aria-selected="false"');
  });

  it("keeps the stop-state release outside the segments, visible in both", () => {
    for (const segment of ["rules", "settings"] as const) {
      const html = render(segment);
      const { rules, settings, operations } = regions(html);
      // Start/stop were unified into the operation bar: the tab
      // itself no longer carries those buttons, in either segment
      // (the release steps still mention the start by name — as
      // prose pointing at the bar, not as a button here).
      expect(operations).not.toContain('aria-label="PAPER運用開始"');
      expect(operations).not.toContain('aria-label="PAPER運用停止"');
      expect(html).not.toContain('aria-label="PAPER運用開始"');
      expect(html).not.toContain('aria-label="PAPER運用停止"');
      // The release section stays: heading once, with its button.
      expect(operations.match(/停止状態の解除/g)).toHaveLength(1);
      expect(operations).toContain("停止解除（再開は手動）");
      // Neither segment panel contains the release section.
      expect(rules).not.toContain("停止状態の解除");
      expect(settings).not.toContain("停止状態の解除");
    }
  });

  it("puts the release section at the top of the page, above the segment switch", () => {
    const html = render("rules");
    const operationsAt = html.indexOf('class="stop-release"');
    const tablistAt = html.indexOf('role="tablist"');
    const rulesAt = html.indexOf('id="strategy-segment-panel-rules"');
    expect(operationsAt).toBeGreaterThanOrEqual(0);
    expect(operationsAt).toBeLessThan(tablistAt);
    expect(tablistAt).toBeLessThan(rulesAt);
    // The source renders the section before the tablist, too.
    expect(strategyTab.indexOf("<StopReleaseSection")).toBeLessThan(
      strategyTab.indexOf('role="tablist"'),
    );
    expect(strategyTab).not.toContain("<PaperOperationControls");
  });

  it("mounts the editor state once, above the segment panels", () => {
    // One hook instance in the tab component feeds both the form
    // and the operation controls; the panels toggle with `hidden`
    // instead of unmounting, which is what preserves unsaved edits.
    expect(strategyTab.match(/useSettingsEditor\(/g)).toHaveLength(1);
    expect(strategyTab).toContain('hidden={segment !== "rules"}');
    expect(strategyTab).toContain('hidden={segment !== "settings"}');
    expect(strategyTab).toContain('role="tablist"');
    expect(strategyTab).toContain("aria-selected={segment === s.id}");
  });

  it("opens the 設定 segment for a restored Settings tab value", () => {
    expect(main).toContain('tab === "Settings" ? "settings" : "rules"');
    const branch = main.slice(main.indexOf('activeTab === "Strategy"'));
    expect(branch).toContain("<StrategyTab");
    expect(branch).toContain("segment={strategySegment}");
    expect(branch).toContain("onSegmentChange={setStrategySegmentChoice}");
  });
});
