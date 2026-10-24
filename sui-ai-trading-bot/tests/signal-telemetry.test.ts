import { describe, expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import {
  defaults,
  type Indicators,
  type MarketContext,
} from "../packages/shared/src/index.ts";

const indicators = (patch: Partial<Indicators> = {}): Indicators => ({
  ema20: 2.01,
  ema50: 2,
  rsi: 31,
  macd: 0,
  signal: 0,
  histogram: 0.01,
  atr: 0.1,
  volumeChange: 0,
  priceChange: 0,
  ...patch,
});

const context = (): MarketContext => ({
  now: 1800000000000,
  entryPrice: null,
  candles: [0, 1].map((i) => ({
    timestamp: 1799999400 + i * 300,
    timeframe: 300,
    source: "fixture",
    open: 2,
    high: 2.1,
    low: 1.9,
    close: 2,
    volume: 100,
  })),
  current: indicators(),
  previous: indicators({ rsi: 30, histogram: 0 }),
});

describe("operation snapshot signal telemetry", () => {
  it("is null before any analysis is recorded", () => {
    const db = new BotDatabase(":memory:");
    const monitor = new OperationMonitor(db);
    expect(monitor.snapshot().signal).toBeNull();
    db.close();
  });

  it("is null when the stored decision carries no evidence", () => {
    const db = new BotDatabase(":memory:");
    // The engine stores this evidence-less placeholder on cycle errors.
    db.set("decision", { action: "WAIT", reason: "SOME_ERROR", confidence: 0 });
    const monitor = new OperationMonitor(db);
    expect(monitor.snapshot().signal).toBeNull();
    db.close();
  });

  it("copies the strategy's recorded evidence verbatim", async () => {
    const db = new BotDatabase(":memory:");
    const c = context();
    const decision = await new RuleBasedStrategy(defaults).analyze(c);
    expect(decision.action).toBe("BUY");
    db.recordAnalysis("cycle-1", decision, c.current, c.now);
    const monitor = new OperationMonitor(db);
    const signal = monitor.snapshot().signal;
    expect(signal).toMatchObject({
      evaluatedAt: c.now,
      action: "BUY",
      selectedRule: "BUY_SIGNAL",
      hasPosition: false,
      price: 2,
      current: { ema20: 2.01, ema50: 2, rsi: 31, histogram: 0.01, atr: 0.1 },
      previous: { rsi: 30, histogram: 0 },
      thresholds: { oversold: defaults.oversold },
      conditions: {
        emaUp: true,
        rsiRecovery: true,
        histogramImproving: true,
      },
    });
    db.close();
  });

  it("flags an open position from the recorded entry price", async () => {
    const db = new BotDatabase(":memory:");
    const c = context();
    c.entryPrice = 2;
    const decision = await new RuleBasedStrategy(defaults).analyze(c);
    db.recordAnalysis("cycle-2", decision, c.current, c.now);
    const monitor = new OperationMonitor(db);
    expect(monitor.snapshot().signal?.hasPosition).toBe(true);
    db.close();
  });

  it("fails closed when a recorded value is not finite", async () => {
    const db = new BotDatabase(":memory:");
    const c = context();
    const decision = await new RuleBasedStrategy(defaults).analyze(c);
    decision.evidence!.inputs.current.rsi = Number.NaN;
    db.recordAnalysis("cycle-3", decision, c.current, c.now);
    const monitor = new OperationMonitor(db);
    expect(monitor.snapshot().signal).toBeNull();
    db.close();
  });
});
