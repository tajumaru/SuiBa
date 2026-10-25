import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  defaults,
  type TradingDecision,
} from "../packages/shared/src/index.ts";
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
    ...rest,
    conditions: {
      emaUp: true,
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
    expect(html).toContain("ルールベース戦略 — どう判定するか");
    expect(html.match(/data-state="met"/g)).toHaveLength(2);
    expect(html.match(/data-state="unmet"/g)).toHaveLength(1);
    expect(html).toContain("買い条件 3つ中 2つ成立");
    // The exact string the localization e2e asserts on this tab.
    expect(html).toContain("取引判定：見送り");
    expect(html).toContain("判断スコア（未校正・勝率ではありません）");
    expect(html).toContain("55 / 100");
    expect(html).not.toContain("55%");
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
