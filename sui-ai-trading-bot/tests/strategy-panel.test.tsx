import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  defaults,
  type TradingDecision,
} from "../packages/shared/src/index.ts";
import type { ProfitReport } from "../packages/profit-guard/src/index.ts";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import type { DecisionTelemetry } from "../apps/worker/src/operations.ts";
import { StrategyPanel } from "../apps/dashboard/src/StrategyPanel.tsx";

type State = ReturnType<BotEngine["snapshot"]>;

function telemetry(
  overrides: Omit<Partial<DecisionTelemetry>, "conditions"> & {
    conditions?: Partial<DecisionTelemetry["conditions"]>;
  } = {},
): DecisionTelemetry {
  const now = Date.now(),
    { conditions, ...rest } = overrides;
  return {
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
    ...rest,
    conditions: {
      emaUp: true,
      emaGapShrinking: false,
      rsiRecovery: true,
      histogramImproving: false,
      hasPosition: false,
      stopLoss: false,
      takeProfit: false,
      ...(conditions ?? {}),
    },
  };
}

function data(decision: TradingDecision | null): State {
  return {
    settings: defaults,
    decision,
    profitGuard: null,
    acquisitionCostUsdc: null,
    acquisitionFees: null,
    portfolio: { sui: 0, usdc: 100, costBasis: 0 },
    price: 2.412,
  } as unknown as State;
}

const waitDecision: TradingDecision = {
  action: "WAIT",
  confidence: 0.55,
  reason: "条件未成立",
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
  timestamp: new Date(Date.now() - 60_000).toISOString(),
};

const render = (state: State, dec: DecisionTelemetry | null) =>
  renderToStaticMarkup(<StrategyPanel data={state} telemetry={dec} />);

describe("strategy panel: slim condition cards", () => {
  it("renders condition cards, the verdict and grouped parameters from real records", () => {
    const html = render(data(waitDecision), telemetry());
    expect(html).toContain("さくせん");
    expect(html.match(/data-state="met"/g)).toHaveLength(2);
    expect(html.match(/data-state="unmet"/g)).toHaveLength(1);
    expect(html).toContain("あと1つ");
    expect(html).not.toContain("買い条件 3つ中");
    // The verdict headline is the action word alone; the localization
    // e2e asserts it scoped to the result card.
    expect(html).toContain("strategy-verdict\">見送り");
    expect(html).not.toContain("取引判定");
    // The slim result card drops the constant/duplicate chips.
    expect(html).not.toContain("確信度");
    expect(html).not.toContain("判定日時");
    // The plain reason repeats the dots, so no reason line.
    expect(html).not.toContain("理由：");
    // Price and judgment time survive as one meta line.
    expect(html).toContain("2.412 USDC");
    expect(html).toContain("時点");
    expect(html).toContain("正常");
    expect(html).not.toContain("✓ 正常（異常なし）");
    expect(html).toContain("1.6倍");
    // Grouped parameter cards replace the flat settings list.
    expect(html).toContain("買い条件");
    expect(html).toContain("売り・リスク");
    expect(html).toContain("ProfitGuard");
    expect(html).toContain("RSIの買い基準");
    expect(html).toContain("出来高変化の上限");
    expect(html).toContain("最低純利益");
    expect(html).toContain("ProfitGuardの詳細（コスト内訳・見積もり）");
    expect(html).toContain("DeepSeek：未実装（拡張用インターフェースのみ）");
    // No editable inputs on this read-only tab.
    expect(html).not.toContain("<input");
    // The cross-route EMA card carries no shrink note.
    expect(html).not.toContain("設定により成立として扱っています");
  });

  it("explains on the EMA card when the condition was met via the shrink route", () => {
    const html = render(
      data(waitDecision),
      telemetry({
        ema20: 2.41,
        ema50: 2.42,
        conditions: { emaUp: true, emaGapShrinking: true },
      }),
    );
    expect(html).toContain("（縮小中）");
    expect(html).not.toContain("今回は差の縮小が続いたため");
    // Still counted as met, from the recorded flag alone.
    expect(html).toContain("あと1つ");
  });

  it("shows the buy verdict with the buy tone when the decision is BUY", () => {
    const html = render(
      data({ ...waitDecision, action: "BUY", confidence: 0.78 }),
      telemetry({ conditions: { histogramImproving: true } }),
    );
    expect(html).toContain("strategy-verdict\">買い");
    expect(html).toContain("strategy-result tone-buy");
    // A BUY verdict implies the conditions; the dots step aside.
    expect(html).not.toContain("strategy-dots");
  });

  it("shows the reason line only when it carries real information", () => {
    const blocked = render(
      data({ ...waitDecision, reason: "ProfitGuardで見送り" }),
      telemetry(),
    );
    expect(blocked).toContain("理由：");
    expect(blocked).toContain("ProfitGuardで見送り");
    const plain = render(data(waitDecision), telemetry());
    expect(plain).not.toContain("理由：");
  });

  it("renders no decision flow when there is no decision evidence", () => {
    const html = render(data(null), null);
    expect(html).not.toContain('data-state="unknown"');
    expect(html).not.toContain("判断根拠データがまだありません");
    expect(html).not.toContain("いまの判定");
    expect(html).toContain("戦略パラメータ");
  });

  it("renders no decision flow from stale evidence", () => {
    const stale = telemetry({
      evaluatedAt: Date.now() - 400_000,
      candleTimestamp: Date.now() - 400_000,
    });
    const html = render(data(waitDecision), stale);
    expect(html).not.toContain('data-state="unknown"');
    expect(html).not.toContain("判断根拠が古いため、状態を表示していません");
    expect(html).not.toContain("いまの判定");
  });

  it("flags a volume exceedance with the strategy's own limit", () => {
    const html = render(data(waitDecision), telemetry({ volumeChange: 4.5 }));
    expect(html).toContain("異常");
    expect(html).not.toContain("✗ 異常（上限超過・見送り対象）");
    expect(html).toContain('data-state="exceeded"');
  });

  // The compact profit-guard summary rounds the worker's decimal
  // strings to four places (the pool tick); the full panel keeps the
  // precise figures. Values mirror a real report shape.
  const buyReport: ProfitReport = {
    allowed: false,
    action: "WAIT",
    reason: "MIN_PROFIT_NOT_MET",
    scope: "BUY_SCENARIO",
    purpose: null,
    asOf: Date.now(),
    validUntil: null,
    quantityAtomic: "1000000000",
    allocatedCostUsdc: null,
    purchaseInputUsdc: "5",
    acquisitionUnitPrice: "0.840619932577",
    netProfitUsdc: "-0.076364",
    netProfitPct: null,
    breakEvenPrice: "0.855851103340",
    roundTripCostUsdc: "0.030100",
    targetPrice: "0.843048850000",
    targetProfitPct: "0.5",
    costs: null,
    buyCosts: null,
    minProfitUsdc: "0.01",
    minProfitPct: "0.0015",
    quoteId: null,
    source: "PAPER_MODEL",
  };
  const withGuard = (report: ProfitReport | null, cost?: string | null) =>
    ({
      ...data(waitDecision),
      profitGuard: report,
      ...(cost !== undefined ? { acquisitionCostUsdc: cost } : {}),
    }) as State;
  // The summary block only: the full panel in the disclosure below it
  // deliberately keeps full precision, so absence checks scope here.
  const summaryOf = (html: string) =>
    html.slice(
      html.indexOf("strategy-pg-try"),
      html.indexOf("strategy-pg-details"),
    );

  it("rounds the profit-guard summary prices and profit to four decimals", () => {
    const html = render(withGuard(buyReport), telemetry());
    expect(html).toContain("費用込み想定取得単価");
    expect(html).toContain("0.8406 USDC / 基軸通貨");
    // 0.855851… rounds up at the fourth place.
    expect(html).toContain("0.8559 USDC / 基軸通貨");
    // Trailing zeros are kept, matching toFixed(4) elsewhere.
    expect(html).toContain("0.8430 USDC");
    expect(html).toContain("-0.0764 USDC");
    expect(html).toContain("利益不足・見送り");
    const summary = summaryOf(html);
    expect(summary).not.toContain("0.840619932577");
    expect(summary).not.toContain("0.855851103340");
    expect(summary).not.toContain("0.076364");
  });

  it("keeps the buy-scenario estimate to three short lines", () => {
    const html = render(withGuard(buyReport), telemetry());
    expect(html).toContain("購入試算");
    expect(html).toContain("往復コスト");
    expect(html).toContain("利確価格");
    expect(html).not.toContain("保証しません");
    expect(html).not.toContain("費用ソースを確認してください");
    expect(html).not.toContain("購入追加手数料");
    expect(html).not.toContain("基軸通貨 ／");
  });

  it("keeps the 不明 rendering when the summary values are null", () => {
    const html = render(
      withGuard({ ...buyReport, breakEvenPrice: null, netProfitUsdc: null }),
      telemetry(),
    );
    expect(html).toContain("モデル損益分岐価格");
    expect(html).toContain("不明");
    expect(html).toContain("計算不能");
    expect(html).not.toContain("-0.0764");
  });

  it("rounds the held-position cost basis in the sell-quote summary", () => {
    const html = render(
      withGuard(
        {
          ...buyReport,
          scope: "SELL_QUOTE",
          allowed: true,
          netProfitUsdc: "1.23456",
        },
        "12.3456789",
      ),
      telemetry(),
    );
    expect(html).toContain("現在の保有分の取得原価");
    expect(html).toContain("12.3457 USDC");
    expect(html).toContain("1.2346 USDC");
    expect(summaryOf(html)).not.toContain("12.3456789");
  });

  // The full panel only: everything before this heading is the
  // compact summary card, which has its own rendering rules.
  const panelOf = (html: string) =>
    html.slice(html.indexOf("ProfitGuard · コスト控除後の利益"));

  it("collapses the detail panel to the verdict when nothing is held and no quote exists", () => {
    const html = render(
      withGuard({
        ...buyReport,
        reason: "QUOTE_UNAVAILABLE",
        quantityAtomic: null,
        purchaseInputUsdc: null,
        acquisitionUnitPrice: null,
        netProfitUsdc: null,
        breakEvenPrice: null,
        roundTripCostUsdc: null,
        targetPrice: null,
      }),
      telemetry(),
    );
    const panel = panelOf(html);
    expect(panel).toContain("見積もり取得失敗");
    expect(panel).not.toContain("現在の保有分の取得原価");
    expect(panel).not.toContain("対象分の取得原価");
    expect(panel).not.toContain("売却追加手数料");
    expect(panel).not.toContain("購入試算");
    expect(panel).not.toContain("不明");
  });

  it("shows the position fields in the detail panel while holding", () => {
    const held = {
      ...withGuard(
        {
          ...buyReport,
          scope: "SELL_QUOTE",
          allocatedCostUsdc: "6.468000",
          costs: {
            additionalFeeUsdc: "0.010000",
            gasUsdc: "0.005000",
            dexFeeUsdc: null,
            source: "PAPER_MODEL",
          } as ProfitReport["costs"],
        },
        "6.468000",
      ),
      portfolio: { sui: 10, usdc: 90, costBasis: 6.468 },
    } as State;
    const panel = panelOf(render(held, telemetry()));
    expect(panel).toContain("現在の保有分の取得原価");
    expect(panel).toContain("平均取得単価 / 現在価格");
    expect(panel).toContain("対象分の取得原価（按分）");
    expect(panel).toContain("モデル損益分岐価格");
    expect(panel).toContain("売却追加手数料");
    // The null DEX fee stays hidden instead of rendering 内訳不明.
    expect(panel).not.toContain("DEX手数料");
  });

  it("shows the conditions as rows in one panel, one key figure each", () => {
    const html = render(data(waitDecision), telemetry());
    expect(html).toContain("strategy-rows");
    expect(html).not.toContain("strategy-viz");
    expect(html).not.toContain("EMA20とEMA50の推移図");
    expect(html).toContain("基準");
    expect(html).not.toContain("短期が長期より上なら上向きの流れ");
    expect(html).not.toContain("前回より上向いていれば成立");
    const rows = html.slice(
      html.indexOf("strategy-rows"),
      html.indexOf("戦略パラメータ"),
    );
    expect(rows).not.toContain("EMA20");
    expect(rows).not.toContain("ヒストグラム");
    // One panel: the verdict comes first, the conditions below it.
    expect(html.indexOf("strategy-result")).toBeLessThan(
      html.indexOf("strategy-rows"),
    );
    expect(html).not.toContain("strategy-arrow");
  });
});

describe("strategy panel: nothing to judge yet", () => {
  it("hides the whole decision flow when telemetry is missing", () => {
    const html = render(data(waitDecision), null);
    expect(html).not.toContain("いまの判定");
    expect(html).not.toContain("未取得");
    expect(html).not.toContain("判断根拠データがまだありません。");
    expect(html).toContain("戦略パラメータ");
  });
  it("hides the flow when telemetry is stale", () => {
    const stale = telemetry({ evaluatedAt: Date.now() - 3_600_000 });
    const html = render(data(waitDecision), stale);
    expect(html).not.toContain("いまの判定");
    expect(html).toContain("戦略パラメータ");
  });
});
