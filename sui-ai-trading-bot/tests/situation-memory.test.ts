import { describe, expect, it } from "vitest";
import {
  aggregateDipReboundMemory,
  aggregateSituationMemory,
  dipReboundEvents,
  liquidationSpike,
  aggregateLiquidationSpikeMemory,
  situationRegimeAt,
} from "../apps/worker/src/situation-memory.ts";
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
  it.each([
    ["up", 0.01],
    ["down", -0.01],
    ["range", 0],
  ] as const)("classifies a %s EMA50 slope", (expected, step) => {
    const candles = Array.from({ length: 289 }, (_, i) =>
      candle(START + i * 300, 100 * (1 + step) ** i),
    );
    expect(situationRegimeAt(candles, candles.at(-1)!.timestamp)).toBe(expected);
  });

  it("classifies insufficient history as unknown", () => {
    expect(situationRegimeAt([candle(START)], START)).toBe("unknown");
  });

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

describe("dip-rebound scene statistic", () => {
  function series(hours = 30) {
    return Array.from({ length: (hours * 3600) / 300 + 1 }, (_, i) =>
      candle(START + i * 300),
    );
  }

  it("detects -3% exactly but not -2.9%", () => {
    const exact = series(5);
    exact[48] = candle(exact[48]!.timestamp, 97);
    expect(dipReboundEvents(exact).map((item) => item.timestamp)).toEqual([
      START + 4 * 3600,
    ]);

    const above = series(5);
    above[48] = candle(above[48]!.timestamp, 97.1);
    expect(dipReboundEvents(above)).toEqual([]);
  });

  it("does not recount a slide until three consecutive false candles", () => {
    const candles = series(6);
    const set = (offset: number, close: number) => {
      candles[offset] = candle(candles[offset]!.timestamp, close);
    };
    set(48, 97); // first event
    set(49, 97.1); // false: 1
    set(50, 97); // true again: still the same slide, reset the false streak
    set(51, 97.1); // false: 1
    set(52, 97.1); // false: 2
    set(53, 97.1); // false: 3, re-armed
    set(54, 97); // a new event
    expect(dipReboundEvents(candles).map((item) => item.timestamp)).toEqual([
      START + 48 * 300,
      START + 54 * 300,
    ]);
  });

  it("does not treat false candles separated by a gap as consecutive", () => {
    const candles = series(6);
    candles[48] = candle(candles[48]!.timestamp, 97);
    candles[49] = candle(candles[49]!.timestamp, 97.1);
    candles[50] = candle(candles[50]!.timestamp, 97.1);
    candles.splice(51, 1); // break the run before the third false candle
    candles[51] = candle(candles[51]!.timestamp, 97.1);
    candles[52] = candle(candles[52]!.timestamp, 97);
    expect(dipReboundEvents(candles).map((item) => item.timestamp)).toEqual([
      START + 48 * 300,
    ]);
  });

  it("uses the +24h axis and 0.2% cost instead of the existing +4h axis", () => {
    const candles = series();
    const eventAt = START + 4 * 3600;
    candles[48] = candle(eventAt, 97);
    candles[96] = candle(eventAt + 4 * 3600, 99);
    candles[336] = candle(eventAt + 24 * 3600, 98.164);
    const result = aggregateDipReboundMemory(candles);
    expect(result).toMatchObject({
      scene: "dip-rebound",
      key: "dip-rebound",
      evaluatedAt: eventAt * 1000,
      n: 1,
      positiveRate: 100,
      periods: [{ period: expect.any(String), n: 1 }],
    });
    expect(result?.mean24hPct).toBeCloseTo(1, 10);
  });
});

describe("liquidation-spike scene statistic", () => {
  it("requires both the relative multiplier and absolute USD floor at their boundaries", () => {
    expect(liquidationSpike(100_000, [20_000, 20_000, 20_000])).toBe(true);
    expect(liquidationSpike(99_999.99, [1, 1, 1])).toBe(false);
    expect(liquidationSpike(100_000, [20_001, 20_001, 20_001])).toBe(false);
  });

  it("counts a qualified external-reference dip on the cost-deducted +24h axis", () => {
    const candles = Array.from({ length: 110 * 12 + 1 }, (_, i) =>
      candle(START + i * 300),
    );
    const eventAt = START + 20 * 4 * 3600;
    const eventIndex = (eventAt - START) / 300;
    candles[eventIndex] = candle(eventAt, 97);
    candles[eventIndex + 288] = candle(eventAt + 24 * 3600, 98.164);
    const result = aggregateLiquidationSpikeMemory(candles, [
      { bucketAt: eventAt, longUsd: 100_000, shortUsd: 0, count: 1 },
    ]);
    expect(result).toMatchObject({
      scene: "liquidation-spike",
      n: 1,
      source: "Binance USD-M Futures (external reference)",
    });
    expect(result?.mean24hPct).toBeCloseTo(1, 10);
  });
});

describe("walrus memory narration", () => {
  const at = START * 1000;
  const statistic = {
    scene: "decision" as const,
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

  it("does not speak for a dip-rebound scene below n=30", () => {
    expect(
      memoryNarration(
        {
          scene: "dip-rebound",
          key: "dip-rebound",
          evaluatedAt: at,
          n: 29,
          mean24hPct: 3.26,
          positiveRate: 88,
          periods: [],
        },
        {},
        at,
      ),
    ).toBeNull();
  });

  it("uses the +24h axis when a dip-rebound scene becomes speakable", () => {
    expect(
      memoryNarration(
        {
          scene: "dip-rebound",
          key: "dip-rebound",
          evaluatedAt: at,
          n: 30,
          mean24hPct: 3.26,
          positiveRate: 88,
          periods: [],
        },
        {},
        at,
      )?.draft.text,
    ).toBe(
      "この手の急落後、過去 n=30 はコスト控除後の +24h 平均 +3.26%、プラス率 88%です。",
    );
  });
});
