import { describe, expect, it } from "vitest";
import {
  defaults,
  type Candle,
  type MarketContext,
} from "../packages/shared/src/index.ts";
import { calculate, rsi } from "../packages/indicators/src/index.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";

/**
 * An uptrend cooling off, tuned against the real indicator maths:
 * EMA20 above EMA50, RSI mid-range (49.8 against oversold 30, the
 * previous candle also above the line so no recovery cross), the
 * MACD histogram improving, flat position. In other words RSI is
 * the only missing buy piece — exactly when the buy-run line is
 * declared.
 */
function tunedCloses(): number[] {
  const closes: number[] = [];
  let p = 1.0;
  for (let i = 0; i < 70; i++) {
    p *= 1.002;
    closes.push(p);
  }
  for (let i = 0; i < 14; i++) {
    p *= 1 - (0.003 - i * 0.0002);
    closes.push(p);
  }
  for (const r of [0.0012, 0.0018]) {
    p *= 1 + r;
    closes.push(p);
  }
  return closes;
}
const toCandles = (closes: number[]): Candle[] =>
  closes.map((close, i) => ({
    timestamp: 1799999400 + i * 300,
    timeframe: 300,
    source: "fixture",
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 100,
  }));
const liveContext = (
  candles: Candle[],
  now: number,
  entryPrice: number | null = null,
): MarketContext => ({
  candles,
  current: calculate(candles),
  previous: calculate(candles.slice(0, -1)),
  entryPrice,
  now,
});

describe("buy-run line (RSI target price)", () => {
  const candles = toCandles(tunedCloses());
  const evaluatedAt = (candles.at(-1)!.timestamp + 300) * 1000;

  it("the strategy records the line when RSI is the only missing piece", async () => {
    const decision = await new RuleBasedStrategy(defaults).analyze(
      liveContext(candles, evaluatedAt),
    );
    const line = decision.evidence?.rsiLinePrice;
    expect(decision.action).toBe("WAIT");
    expect(line).not.toBeNull();
    expect(line!).toBeLessThan(candles.at(-1)!.close);
    expect(line!).toBeGreaterThan(0);
    // The recorded line is honest: a next candle closing there
    // brings RSI exactly to the oversold line.
    const closes = candles.map((c) => c.close);
    expect(rsi([...closes, line!])).toBeCloseTo(defaults.oversold, 6);
  });

  it("no line while a position is open", async () => {
    const decision = await new RuleBasedStrategy(defaults).analyze(
      liveContext(candles, evaluatedAt, 1.05),
    );
    expect(decision.evidence?.rsiLinePrice).toBeNull();
  });

  it("telemetry carries the line, and legacy evidence reads as null", async () => {
    const db = new BotDatabase(":memory:");
    const decision = await new RuleBasedStrategy(defaults).analyze(
      liveContext(candles, evaluatedAt),
    );
    db.set("decision", decision);
    const telemetry = new OperationMonitor(db).decisionTelemetry(
      evaluatedAt + 60_000,
    );
    expect(telemetry?.rsiLinePrice).toBe(decision.evidence?.rsiLinePrice);

    const legacy = JSON.parse(JSON.stringify(decision)) as typeof decision;
    delete legacy.evidence!.rsiLinePrice;
    db.set("decision", legacy);
    const legacyTelemetry = new OperationMonitor(db).decisionTelemetry(
      evaluatedAt + 60_000,
    );
    expect(legacyTelemetry).not.toBeNull();
    expect(legacyTelemetry?.rsiLinePrice).toBeNull();
    db.close();
  });
});
