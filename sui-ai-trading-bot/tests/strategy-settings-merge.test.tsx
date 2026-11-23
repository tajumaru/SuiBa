import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { readAppShell } from "./helpers/source";
import { defaults } from "../packages/shared/src/index.ts";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import type { DecisionTelemetry } from "../apps/worker/src/operations.ts";
import { StrategyPanel } from "../apps/dashboard/src/StrategyPanel.tsx";
import { SettingsPage } from "../apps/dashboard/src/SettingsPage.tsx";
import {
  NAV_SHORT_LABELS,
  NavTabIcon,
} from "../apps/dashboard/src/navTabs.tsx";

type State = ReturnType<BotEngine["snapshot"]>;

const shell = readAppShell();

describe("strategy / settings tab merge (app shell wiring)", () => {
  it("has exactly four nav tabs and no settings tab", () => {
    const block = shell.slice(
      shell.indexOf("const NAV_TABS = ["),
      shell.indexOf("];", shell.indexOf("const NAV_TABS = [")),
    );
    const entries = block.match(/"[^"]+"|運用検証|バックテスト比較/g) ?? [];
    expect(entries).toHaveLength(4);
    expect(block).not.toContain('"Settings"');
    expect(shell).not.toContain('activeTab === "Settings"');
  });

  it("falls a restored Settings value back to the strategy tab", () => {
    expect(shell).toContain('tab === "Settings"');
    expect(shell).toContain('? "Strategy"');
    // ... on its 設定 segment (see strategy-segments.test.tsx).
    expect(shell).toContain('tab === "Settings" ? "settings" : "rules"');
    // Any other unknown value still falls back to the dashboard.
    expect(shell).toContain(': "Overview"');
  });

  it("renders the strategy tab composition on the strategy tab", () => {
    // The diagram view and the settings editor are composed by
    // StrategyTab (segment switch: ルール / 設定, with the PAPER
    // operation controls always visible below the segments).
    const branch = shell.slice(shell.indexOf('activeTab === "Strategy"'));
    expect(branch).toContain("<StrategyTab");
    expect(branch).toContain("segment={strategySegment}");
  });

  it("points the tab-independent notices at the strategy tab", () => {
    expect(shell).toContain('onOpenStrategy={() => setTab("Strategy")}');
    expect(shell).not.toContain("設定の「停止状態の解除」");
    expect(shell).not.toContain("<RecoveryGuidance");
  });

  it("drops the settings entry from the mobile tab bar metadata", () => {
    expect(Object.keys(NAV_SHORT_LABELS)).toHaveLength(4);
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
  // Fresh telemetry: with no decision evidence the strategy panel
  // hides its diagram entirely (owner's rule), which is covered by
  // strategy-panel.test.tsx; this composition test needs the diagram.
  const now = Date.now();
  const telemetry = {
    evaluatedAt: now - 60_000,
    candleTimestamp: now - 300_000,
    action: "WAIT",
    reason: "条件未成立",
    selectedRule: "NO_SIGNAL",
    sellPurpose: null,
    price: 2.412,
    entryPrice: null,
    ema20: 2.438,
    ema50: 2.421,
    rsi: 41,
    previousRsi: 28,
    histogram: -0.0012,
    previousHistogram: -0.0015,
    atr: 0.02,
    volumeChange: 0.6,
    oversold: 30,
    overbought: 70,
    stopLossPct: 0.02,
    takeProfitPct: 0.04,
    rsiLinePrice: null,
    conditions: {
      emaUp: true,
      emaGapShrinking: false,
      rsiRecovery: true,
      histogramImproving: false,
      hasPosition: false,
      stopLoss: false,
      takeProfit: false,
    },
  } as unknown as DecisionTelemetry;
  const html = renderToStaticMarkup(
    <>
      <StrategyPanel data={data} telemetry={telemetry} />
      <SettingsPage
        data={data}
        api={vi.fn()}
        onSaved={async () => {}}
        control={async () => null}
      />
    </>,
  );

  it("orders diagram, editor and stop-state release on one tab", () => {
    const diagram = html.indexOf("さくせん");
    const editor = html.indexOf("かんたん設定");
    const release = html.indexOf("停止状態の解除");
    expect(diagram).toBeGreaterThanOrEqual(0);
    expect(editor).toBeGreaterThan(diagram);
    expect(release).toBeGreaterThan(editor);
    expect(html.match(/停止状態の解除/g)).toHaveLength(1);
    expect(html).toContain("緊急停止を解除（再開は手動）");
    // The full save flow stays available on the merged tab. The
    // always-on preview box is gone — the diff shows only in the
    // save review — and the saved-settings summary is gone too:
    // the form itself holds the saved values.
    expect(html).not.toContain("適用予定の設定");
    expect(html).not.toContain("保存済みの設定");
    expect(html).toContain("PAPER運用開始");
  });

  it("shows the profit-guard state once, with the toggle in the editor", () => {
    // State: the strategy view's ProfitGuard card and its detail
    // disclosure are the single status surface.
    expect(html).toContain("ProfitGuard");
    expect(html.match(/ProfitGuardの詳細（コスト内訳・見積もり）/g)).toHaveLength(
      1,
    );
    // The duplicated summary that used to sit in the saved-settings
    // block is gone, and the edit toggle appears exactly once.
    expect(html).not.toContain("最後の判定");
    expect(html.match(/ProfitGuardを有効にする/g)).toHaveLength(1);
  });
});
