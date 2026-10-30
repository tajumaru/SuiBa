import { describe, it, expect } from "vitest";
import {
  compareBacktests,
  type ComparisonInput,
  type Dependencies,
} from "../packages/backtest-engine/src/index.ts";
import {
  defaults,
  type Candle,
  type TradingDecision,
} from "../packages/shared/src/index.ts";
import {
  REPLAY_SPEEDS,
  clampReplayIndex,
  replayFrame,
  replayIntervalMs,
  replayLength,
} from "../apps/dashboard/src/backtestReplay.ts";

const start = 1800000000;
const history = (): Candle[] =>
  Array.from({ length: 100 }, (_, i) => ({
    timestamp: start + i * 300,
    timeframe: 300,
    source: "SYNTHETIC_TEST",
    open: 2,
    close: 2,
    high: 2.01,
    low: 1.99,
    volume: 100000,
  }));
const options: ComparisonInput = {
  start: start + 65 * 300,
  end: start + 99 * 300,
  trainEnd: start + 64 * 300,
};
const decision = (
  action: TradingDecision["action"],
  purpose: TradingDecision["sellPurpose"] = "TAKE_PROFIT",
): TradingDecision => ({
  action,
  sellPurpose: purpose,
  confidence: 1,
  reason: "TEST",
  timestamp: new Date(start * 1000).toISOString(),
  stopLossPct: 0.02,
  takeProfitPct: 0.04,
});
const cycle: Dependencies = {
  strategyFactory: () => ({
    analyze: async (c) =>
      decision(c.entryPrice === null ? "BUY" : "SELL", "STOP_LOSS"),
  }),
};

describe("backtest replay frames", () => {
  it("aligns candles, curve points and events one-per-bar", async () => {
    const result = await compareBacktests(history(), options, defaults, cycle);
    // Validation period is bars 65..99 inclusive.
    expect(replayLength(result, "on")).toBe(35);
    expect(replayLength(result, "off")).toBe(35);
    const frame = replayFrame(result, "off", 10)!;
    expect(frame.candle).toBe(result.candles[10]);
    expect(frame.curvePoint).toBe(result.off.curve[10]);
    expect(frame.event).toBe(result.off.events[10]);
    expect(frame.total).toBe(35);
    expect(frame.isEnd).toBe(false);
  });

  it("clamps out-of-range positions to the recorded period", async () => {
    const result = await compareBacktests(history(), options, defaults, cycle);
    expect(clampReplayIndex(result, "on", -5)).toBe(0);
    expect(clampReplayIndex(result, "on", 9999)).toBe(34);
    expect(replayFrame(result, "on", 9999)!.index).toBe(34);
    expect(replayFrame(result, "on", 9999)!.isEnd).toBe(true);
  });

  it("accumulates fills, holdings and realised profit only up to the cursor", async () => {
    const result = await compareBacktests(history(), options, defaults, cycle);
    const last = replayFrame(result, "off", 34)!;
    expect(last.trades.length).toBeGreaterThan(0);
    expect(last.buyCount + last.sellCount).toBe(last.trades.length);
    expect(last.buyCount).toBe(result.off.summary.buyCount);
    expect(last.sellCount).toBe(result.off.summary.sellCount);
    // The cycling strategy always exits, so nothing is held at the end and
    // realised profit matches the sum of the recorded SELL fills.
    expect(last.holdingsSui).toBeCloseTo(0, 9);
    const realised = last.trades
      .filter((t) => t.side === "SELL")
      .reduce((s, t) => s + Number(t.realizedProfitUsdc ?? t.pnl ?? 0), 0);
    expect(last.realizedPnl).toBeCloseTo(realised, 9);
    expect(last.equity).toBe(result.off.curve.at(-1)!.equity);

    const first = replayFrame(result, "off", 0)!;
    expect(first.trades.length).toBeLessThanOrEqual(1);
    expect(first.recentEvents).toHaveLength(1);
    expect(last.recentEvents).toHaveLength(5);
    expect(last.recentEvents[0]).toBe(result.off.events[34]);
  });

  it("returns no frame when there is nothing to replay", () => {
    const empty = {
      candles: [],
      options: { initialUsdc: 100 },
      on: { curve: [], events: [] },
      off: { curve: [], events: [] },
    } as unknown as Awaited<ReturnType<typeof compareBacktests>>;
    expect(replayLength(empty, "on")).toBe(0);
    expect(replayFrame(empty, "on", 0)).toBeNull();
  });

  it("keeps playback intervals positive and faster at higher speeds", () => {
    const intervals = REPLAY_SPEEDS.map(replayIntervalMs);
    expect(intervals.every((ms) => ms >= 20)).toBe(true);
    expect([...intervals].sort((a, b) => a - b)).not.toEqual(intervals);
    expect(intervals).toEqual([...intervals].sort((a, b) => b - a));
  });
});
