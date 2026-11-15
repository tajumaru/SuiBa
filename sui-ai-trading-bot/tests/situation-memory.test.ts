import { describe, expect, it } from "vitest";
import { aggregateSituationMemory } from "../apps/worker/src/situation-memory.ts";
import {
  memoryNarration,
  MEMORY_COOLDOWN_MS,
} from "../apps/dashboard/src/narration/memory.ts";
import type { Candle, TradingDecision } from "../packages/shared/src/index.ts";

const START = 1_800_000_000;

function candle(timestamp: number, close = 100): Candle {
  return {
    timestamp,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    source: "test",
    timeframe: 300,
  };
}

function decision(timestamp: number): TradingDecision {
  return {
    action: "BUY",
    reason: "test",
    confidence: 1,
    stopLossPct: 0.01,
    takeProfitPct: 0.015,
    timestamp: new Date(timestamp * 1000).toISOString(),
    evidence: {
      version: 1,
      evaluatedAt: timestamp * 1000,
      candleTimestamp: timestamp,
      previousCandleTimestamp: timestamp - 300,
      selectedRule: "BUY_SIGNAL",
      inputs: {
        price: 100,
        latestVolume: 1,
        previousVolume: 1,
        entryPrice: null,
        current: {
          ema20: 100,
          ema50: 100,
          rsi: 35,
          macd: 1,
          signal: 0,
          histogram: 1,
          atr: 1,
          volumeChange: 0,
          priceChange: 0,
        },
        previous: {
          ema20: 100,
          ema50: 100,
          rsi: 30,
          macd: 0,
          signal: 0,
          histogram: 0,
          atr: 1,
          volumeChange: 0,
          priceChange: 0,
        },
      },
      thresholds: {
        oversold: 30,
        overbought: 70,
        maxVolumeChange: 5,
        stopLossPct: 0.01,
        takeProfitPct: 0.015,
      },
      conditions: {
        emaUp: true,
        emaGapShrinking: false,
        rsiRecovery: true,
        histogramImproving: true,
        hasPosition: false,
        stopLoss: false,
        takeProfit: false,
      },
    },
  };
}

describe("situation memory statistic", () => {
  it("matches the review's regime bucket and cost-deducted exact +4h yardstick", () => {
    const candles: Candle[] = [];
    for (let t = START - 86400; t <= START + 7 * 3600; t += 300)
      candles.push(candle(t));
    const rows = Array.from({ length: 30 }, (_, i) => {
      const timestamp = START + i * 300;
      const target = candles.find(
        (item) => item.timestamp === timestamp + 4 * 3600,
      )!;
      Object.assign(target, candle(target.timestamp, 101));
      return {
        id: `cycle-${i}`,
        timestamp: timestamp * 1000,
        decision: decision(timestamp),
      };
    });
    const result = aggregateSituationMemory(rows, [], candles);
    expect(result).toMatchObject({
      key: "range:rule-buy",
      regime: "range",
      kind: "rule-buy",
      evaluatedAt: (START + 29 * 300) * 1000,
      n: 30,
      positiveRate: 100,
    });
    expect(result?.mean4hPct).toBeCloseTo(0.4, 10);
  });
});

describe("walrus memory narration", () => {
  const at = START * 1000;
  const statistic = {
    key: "up:near-buy",
    regime: "up" as const,
    kind: "near-buy" as const,
    evaluatedAt: at,
    n: 30,
    mean4hPct: -0.8,
    positiveRate: 41,
  };

  it("is silent at n=29, without a clear bias, and during the per-situation cooldown", () => {
    expect(memoryNarration({ ...statistic, n: 29 }, {}, at)).toBeNull();
    expect(
      memoryNarration({ ...statistic, mean4hPct: 0.299 }, {}, at),
    ).toBeNull();
    expect(
      memoryNarration(
        statistic,
        { [statistic.key]: at - MEMORY_COOLDOWN_MS + 1 },
        at,
      ),
    ).toBeNull();
  });

  it("locks the biased statistic-only wording at n=30", () => {
    expect(memoryNarration(statistic, {}, at)?.draft).toMatchInlineSnapshot(`
      {
        "at": 1800000000000,
        "kind": "memory",
        "text": "この手の上昇局面、過去 n=30 はコスト控除後の +4h 平均 -0.80%、プラス率 41%です。",
      }
    `);
  });

  it("locks the one-episode recall attachment and otherwise keeps the statistic unchanged", () => {
    expect(
      memoryNarration(
        { ...statistic, recall: "似た局面では出来高の戻りを待った" },
        {},
        at,
      )?.draft,
    ).toMatchInlineSnapshot(`
      {
        "at": 1800000000000,
        "kind": "memory",
        "text": "この手の上昇局面、過去 n=30 はコスト控除後の +4h 平均 -0.80%、プラス率 41%です。 記憶には「似た局面では出来高の戻りを待った」があります。",
      }
    `);
  });
});
