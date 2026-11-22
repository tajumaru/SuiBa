import { describe, expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import type { TradingDecision } from "../packages/shared/src/index.ts";
import { computeSignalFunnel } from "../apps/worker/src/operations-report.ts";

const now = 1_800_000_000_000;
const hour = 60 * 60 * 1000;

function decision(
  action: TradingDecision["action"],
  conditions: Record<string, boolean>,
): TradingDecision {
  return {
    action,
    confidence: 0,
    reason: "test",
    stopLossPct: null,
    takeProfitPct: null,
    timestamp: new Date(now).toISOString(),
    evidence: {
      version: 1,
      evaluatedAt: now,
      candleTimestamp: 0,
      previousCandleTimestamp: 0,
      inputs: {
        price: 1,
        latestVolume: 0,
        previousVolume: 0,
        entryPrice: null,
        current: {},
        previous: {},
      },
      thresholds: {
        oversold: 45,
        overbought: 70,
        maxVolumeChange: 0,
        stopLossPct: 0,
        takeProfitPct: 0,
      },
      conditions,
      selectedRule: "test",
    } as TradingDecision["evidence"],
  };
}

describe("computeSignalFunnel", () => {
  it("counts evaluations, per-condition passes, near misses and BUY signals in 24h", () => {
    const db = new BotDatabase(":memory:");
    try {
      const rows: [string, TradingDecision, number][] = [
        // All three buy conditions met -> BUY signal.
        ["a", decision("BUY", { emaUp: true, rsiRecovery: true, histogramImproving: true }), now - hour],
        // EMA via the gap-shrink route + RSI, MACD missing -> near miss.
        ["b", decision("WAIT", { emaUp: false, emaGapShrinking: true, rsiRecovery: true, histogramImproving: false }), now - 2 * hour],
        // Only RSI -> no near miss.
        ["c", decision("WAIT", { emaUp: false, rsiRecovery: true, histogramImproving: false }), now - 3 * hour],
        // Nothing met.
        ["d", decision("WAIT", { emaUp: false, rsiRecovery: false, histogramImproving: false }), now - 4 * hour],
        // Outside the 24h window -> excluded.
        ["e", decision("BUY", { emaUp: true, rsiRecovery: true, histogramImproving: true }), now - 25 * hour],
        // No evidence -> not an evaluation.
        ["f", { ...decision("WAIT", {}), evidence: undefined }, now - hour],
      ];
      for (const [id, d, at] of rows) db.append("strategy_decisions", id, d, at);
      expect(computeSignalFunnel(db, now)).toEqual({
        windowHours: 24,
        evaluations: 4,
        buySignals: 1,
        nearMiss: 1,
        conditionPass: { ema: 2, rsi: 3, macd: 1 },
      });
    } finally {
      db.close();
    }
  });

  it("returns zeros when nothing was recorded", () => {
    const db = new BotDatabase(":memory:");
    try {
      expect(computeSignalFunnel(db, now)).toEqual({
        windowHours: 24,
        evaluations: 0,
        buySignals: 0,
        nearMiss: 0,
        conditionPass: { ema: 0, rsi: 0, macd: 0 },
      });
    } finally {
      db.close();
    }
  });
});
