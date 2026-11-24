import { describe, expect, it } from "vitest";
import { aggregateSituationMemory } from "../apps/worker/src/situation-memory.ts";

type DecisionRow = Parameters<typeof aggregateSituationMemory>[0][number];
type Candle = Parameters<typeof aggregateSituationMemory>[2][number];

const oldest = 1_800_000_000;
const candleTimestamp = oldest - 4 * 3600;
const evaluatedAt = candleTimestamp * 1000;
const candles: Candle[] = [
  { timeframe: 300, timestamp: oldest, close: 110 } as Candle,
];

function oldDecision(action: "BUY" | "WAIT"): DecisionRow {
  return {
    id: "old-cycle",
    timestamp: evaluatedAt,
    decision: {
      action,
      evidence: {
        candleTimestamp,
        evaluatedAt,
        inputs: { price: 100 },
        conditions: {},
      },
    } as DecisionRow["decision"],
  };
}

describe("situation memory before the oldest retained candle", () => {
  it("counts a rule decision whose four-hour result is the oldest candle", () => {
    expect(
      aggregateSituationMemory([oldDecision("BUY")], [], candles),
    ).toMatchObject({
      kind: "rule-buy",
      regime: "unknown",
      evaluatedAt,
      n: 1,
    });
    expect(aggregateSituationMemory([], [], candles)).toBeNull();
  });

  it("uses an old decision to match a shadow buy by cycle ID", () => {
    const shadows = [
      {
        cycleId: "old-cycle",
        candleTimestamp,
        action: "BUY",
        status: "OK",
      },
    ];

    expect(
      aggregateSituationMemory([oldDecision("WAIT")], shadows, candles),
    ).toMatchObject({
      kind: "shadow-ai-buy",
      regime: "unknown",
      evaluatedAt,
      n: 1,
    });
    expect(aggregateSituationMemory([], shadows, candles)).toBeNull();
  });
});
