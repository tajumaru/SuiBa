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
    // Any other unknown value still falls back to the dashboard.
    expect(main).toContain(': "Overview"');
  });

  it("renders the diagram view, then the settings editor, on the strategy tab", () => {
    const branch = main.slice(main.indexOf('activeTab === "Strategy"'));
    expect(branch.indexOf("<StrategyPanel")).toBeGreaterThanOrEqual(0);
    expect(branch.indexOf("<SettingsPage")).toBeGreaterThan(
      branch.indexOf("<StrategyPanel"),
    );
  });

  it("points the tab-independent notices at the strategy tab", () => {
    expect(main).toContain("戦略の「停止状態の解除」から解除後");
    expect(main).not.toContain("設定の「停止状態の解除」");
    expect(main).toContain("戦略で保存済みの条件を確認し");
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
        control={async () => {}}
      />
    </>,
  );

  it("orders diagram, editor and stop-state release on one tab", () => {
    const diagram = html.indexOf("ルールベース戦略 — どう判定するか");
    const editor = html.indexOf("かんたん設定");
    const release = html.indexOf("停止状態の解除");
    expect(diagram).toBeGreaterThanOrEqual(0);
    expect(editor).toBeGreaterThan(diagram);
    expect(release).toBeGreaterThan(editor);
    expect(html.match(/停止状態の解除/g)).toHaveLength(1);
    expect(html).toContain("停止解除（再開は手動）");
    // The full save flow stays available on the merged tab.
    expect(html).toContain("適用予定の設定");
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
