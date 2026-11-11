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
import type { IndicatorPoint } from "../apps/dashboard/src/strategyView.ts";

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

const render = (
  state: State,
  dec: DecisionTelemetry | null,
  history: IndicatorPoint[] = [],
) =>
  renderToStaticMarkup(
    <StrategyPanel data={state} telemetry={dec} history={history} />,
  );

describe("strategy panel: diagram-first layout", () => {
  it("renders condition cards, the verdict and grouped parameters from real records", () => {
    const html = render(data(waitDecision), telemetry());
    expect(html).toContain("売買ルール");
    expect(html.match(/data-state="met"/g)).toHaveLength(2);
    expect(html.match(/data-state="unmet"/g)).toHaveLength(1);
    expect(html).toContain("買い条件 3つ中 2つ成立");
    // The exact string the localization e2e asserts on this tab.
    expect(html).toContain("取引判定：見送り");
    expect(html).toContain("確信度");
    expect(html).toContain("55%");
    expect(html).toContain("損切り");
    expect(html).toContain("利確");
    expect(html).toContain("判定日時");
    expect(html).toContain("✓ 正常（異常なし）");
    expect(html).toContain("1.6倍");
    // Grouped parameter cards replace the flat settings list.
    expect(html).toContain("買い条件");
    expect(html).toContain("売り・リスク");
    expect(html).toContain("ProfitGuard（利益保護）");
    expect(html).toContain("RSIの買い基準");
    expect(html).toContain("出来高変化の上限");
    expect(html).toContain("最低純利益");
    expect(html).toContain("利益保護の詳細（コスト内訳・見積もり）");
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
    expect(html).toContain(
      "今回は差の縮小が続いたため、設定により成立として扱っています（短期はまだ長期の下）",
    );
    // Still counted as met, from the recorded flag alone.
    expect(html).toContain("買い条件 3つ中 2つ成立");
  });

  it("shows the buy verdict with the buy tone when the decision is BUY", () => {
    const html = render(
      data({ ...waitDecision, action: "BUY", confidence: 0.78 }),
      telemetry({ conditions: { histogramImproving: true } }),
    );
    expect(html).toContain("取引判定：買い");
    expect(html).toContain("strategy-result tone-buy");
    expect(html).toContain("買い条件 3つ中 3つ成立");
  });

  it("marks every card 未取得 when there is no decision evidence", () => {
    const html = render(data(null), null);
    // Three condition cards plus the volume bar.
    expect(html.match(/data-state="unknown"/g)).toHaveLength(4);
    expect(html).toContain("判断根拠データがまだありません");
    expect(html).not.toContain("買い条件 3つ中");
    expect(html).toContain(
      "判定はまだありません。市場データの取得をお待ちください。",
    );
  });

  it("does not colour stale evidence as if it were current", () => {
    const stale = telemetry({
      evaluatedAt: Date.now() - 400_000,
      candleTimestamp: Date.now() - 400_000,
    });
    const html = render(data(waitDecision), stale);
    // Three condition cards plus the volume bar.
    expect(html.match(/data-state="unknown"/g)).toHaveLength(4);
    expect(html).toContain("判断根拠が古いため、状態を表示していません");
  });

  it("flags a volume exceedance with the strategy's own limit", () => {
    const html = render(data(waitDecision), telemetry({ volumeChange: 4.5 }));
    expect(html).toContain("✗ 異常（上限超過・見送り対象）");
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

  it("falls back to a level view until history accumulates, then draws the series", () => {
    const dec = telemetry();
    expect(render(data(waitDecision), dec)).toContain(
      "履歴が貯まるまでは、現在値の水準で表示しています",
    );
    const history: IndicatorPoint[] = [
      {
        evaluatedAt: dec.evaluatedAt - 60_000,
        price: 2.4,
        ema20: 2.41,
        ema50: 2.4,
        rsi: 38,
        histogram: -0.002,
      },
    ];
    const withHistory = render(data(waitDecision), dec, history);
    expect(withHistory).toContain("EMA20とEMA50の推移図");
    expect(withHistory).not.toContain("履歴が貯まるまでは");
  });
});
