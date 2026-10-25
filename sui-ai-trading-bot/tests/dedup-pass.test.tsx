import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaults } from "../packages/shared/src/index.ts";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import {
  PaperOperationControls,
  type SettingsEditor,
} from "../apps/dashboard/src/SettingsPage.tsx";
import { ProfitGuardSummary } from "../apps/dashboard/src/ProfitGuardPanel.tsx";

type State = ReturnType<BotEngine["snapshot"]>;

const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");
const css = readFileSync(resolve("apps/dashboard/src/style.css"), "utf8");
const operationOverview = readFileSync(
  resolve("apps/dashboard/src/OperationOverview.tsx"),
  "utf8",
);
const operationsPanel = readFileSync(
  resolve("apps/dashboard/src/OperationsPanel.tsx"),
  "utf8",
);

describe("dashboard dedup: SUI price lives only in the ticker", () => {
  it("drops the SUI価格 card from the overview cards, keeping the other seven", () => {
    expect(main).not.toContain("SUI価格");
    for (const label of [
      "仮想総資産",
      "累計損益",
      "日次損益（日本時間09:00から）",
      "仮想SUI",
      "仮想USDC",
      "本日の取引（日本時間09:00から）",
      "未実現損益",
    ])
      expect(main).toContain(label);
  });
});

describe("dashboard dedup: operation state lives in the operation bar", () => {
  it("removes the hero state headline and its styles", () => {
    expect(operationOverview).not.toContain("operation-state");
    expect(css).not.toContain(".operation-state");
    // The guidance below the hero stays.
    expect(operationOverview).toContain("なぜ売買されない？");
    expect(operationOverview).toContain("次に確認すること");
  });

  it("names the operation controls heading without a state word", () => {
    const editor = {
      busy: false,
      dirty: false,
      conflict: false,
      switchTo: null,
    } as unknown as SettingsEditor;
    const data = {
      settings: defaults,
      runtime: { running: true, emergency: false, error: null },
    } as unknown as State;
    const html = renderToStaticMarkup(
      <PaperOperationControls
        data={data}
        editor={editor}
        control={async () => null}
      />,
    );
    expect(html).toContain(">PAPER運用</h3>");
    expect(html).not.toContain("PAPER運用：");
  });
});

describe("dashboard dedup: period totals live in the operations reports", () => {
  it("keeps trade count and net PnL out of the main KPI grid only", () => {
    const kpiStart = operationsPanel.indexOf('aria-label="主要KPI"');
    const kpiEnd = operationsPanel.indexOf("<OperationGuidance");
    expect(kpiStart).toBeGreaterThan(-1);
    expect(kpiEnd).toBeGreaterThan(kpiStart);
    const kpi = operationsPanel.slice(kpiStart, kpiEnd);
    expect(kpi).not.toContain("<h3>取引回数</h3>");
    expect(kpi).not.toContain("<h3>純損益</h3>");
    expect(kpi).toContain("<h3>稼働時間・稼働率</h3>");
    expect(kpi).toContain("<h3>データ正常性</h3>");
    // The 24h / 7d reports below remain the home of the period totals.
    const report = operationsPanel.slice(
      operationsPanel.indexOf("24時間・7日間の検証レポート"),
    );
    expect(report).toContain("取引回数");
    expect(report).toContain("純損益（保有分の評価損益を含む）");
  });
});

describe("dashboard dedup: profit guard detail lives on the strategy tab", () => {
  const renderSummary = (profitGuardEnabled: boolean, profitGuard: unknown) =>
    renderToStaticMarkup(
      <ProfitGuardSummary
        data={
          {
            settings: { ...defaults, profitGuardEnabled },
            profitGuard,
          } as unknown as State
        }
      />,
    );

  it("shows the overview as a one-line summary with the latest verdict", () => {
    const html = renderSummary(true, {
      reason: "MINIMUM_NET_PROFIT_NOT_MET",
    });
    expect(html).toContain("利益保護：有効");
    expect(html).toContain(
      "直近の判定：手数料控除後の利益が最低条件に届きません",
    );
    // None of the full detail panel leaks into the overview.
    expect(html).not.toContain("モデル損益分岐価格");
    expect(html).not.toContain("現在の保有分の取得原価");
  });

  it("shows just the state when disabled and no verdict exists", () => {
    const html = renderSummary(false, null);
    expect(html).toContain("利益保護：無効");
    expect(html).toContain("判定データはまだありません");
  });

  it("wires the overview to the summary, not the full panel", () => {
    expect(main).toContain("<ProfitGuardSummary");
    expect(main).not.toContain("<ProfitGuardPanel");
  });
});
