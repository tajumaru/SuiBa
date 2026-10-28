import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaults } from "../packages/shared/src/index.ts";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import { StrategyPanel } from "../apps/dashboard/src/StrategyPanel.tsx";
import { SettingsPage } from "../apps/dashboard/src/SettingsPage.tsx";
import {
  NAV_SHORT_LABELS,
  NavTabIcon,
} from "../apps/dashboard/src/navTabs.tsx";

type State = ReturnType<BotEngine["snapshot"]>;

const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");

describe("strategy / settings tab merge (main.tsx wiring)", () => {
  it("has exactly six nav tabs and no settings tab", () => {
    const block = main.slice(
      main.indexOf("const NAV_TABS = ["),
      main.indexOf("];", main.indexOf("const NAV_TABS = [")),
    );
    const entries = block.match(/"[^"]+"|運用検証|バックテスト比較/g) ?? [];
    expect(entries).toHaveLength(6);
    expect(block).not.toContain('"Settings"');
    expect(main).not.toContain('activeTab === "Settings"');
  });

  it("falls a restored Settings value back to the strategy tab", () => {
    expect(main).toContain('tab === "Settings"');
    expect(main).toContain('? "Strategy"');
    // ... on its 設定 segment (see strategy-segments.test.tsx).
    expect(main).toContain('tab === "Settings" ? "settings" : "rules"');
    // Any other unknown value still falls back to the dashboard.
    expect(main).toContain(': "Overview"');
  });

  it("renders the strategy tab composition on the strategy tab", () => {
    // The diagram view and the settings editor are composed by
    // StrategyTab (segment switch: ルール / 設定, with the PAPER
    // operation controls always visible below the segments).
    const branch = main.slice(main.indexOf('activeTab === "Strategy"'));
    expect(branch).toContain("<StrategyTab");
    expect(branch).toContain("segment={strategySegment}");
  });

  it("points the tab-independent notices at the strategy tab", () => {
    expect(main).toContain('onOpenStrategy={() => setTab("Strategy")}');
    expect(main).not.toContain("設定の「停止状態の解除」");
    expect(main).not.toContain("<RecoveryGuidance");
  });

  it("drops the settings entry from the mobile tab bar metadata", () => {
    expect(Object.keys(NAV_SHORT_LABELS)).toHaveLength(6);
    expect(NAV_SHORT_LABELS).not.toHaveProperty("Settings");
    expect(renderToStaticMarkup(<NavTabIcon tab="Settings" />)).toBe("");
  });
});

describe("merged strategy tab content", () => {
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
  const html = renderToStaticMarkup(
    <>
      <StrategyPanel data={data} telemetry={null} history={[]} />
      <SettingsPage
        data={data}
        api={vi.fn()}
        onSaved={async () => {}}
        control={async () => null}
      />
    </>,
  );

  it("orders diagram, editor and stop-state release on one tab", () => {
    const diagram = html.indexOf("売買ルール");
    const editor = html.indexOf("かんたん設定");
    const release = html.indexOf("停止状態の解除");
    expect(diagram).toBeGreaterThanOrEqual(0);
    expect(editor).toBeGreaterThan(diagram);
    expect(release).toBeGreaterThan(editor);
    expect(html.match(/停止状態の解除/g)).toHaveLength(1);
    expect(html).toContain("停止解除（再開は手動）");
    // The full save flow stays available on the merged tab. The
    // always-on preview box is gone — the diff shows only in the
    // save review — while the saved values stay on the page.
    expect(html).not.toContain("適用予定の設定");
    expect(html).toContain("保存済みの設定");
    expect(html).toContain("PAPER運用開始");
  });

  it("shows the profit-guard state once, with the toggle in the editor", () => {
    // State: the strategy view's ProfitGuard card and its detail
    // disclosure are the single status surface.
    expect(html).toContain("ProfitGuard（利益保護）");
    expect(html.match(/利益保護の詳細（コスト内訳・見積もり）/g)).toHaveLength(
      1,
    );
    // The duplicated summary that used to sit in the saved-settings
    // block is gone, and the edit toggle appears exactly once.
    expect(html).not.toContain("最後の判定");
    expect(html.match(/利益保護を有効にする/g)).toHaveLength(1);
  });
});
