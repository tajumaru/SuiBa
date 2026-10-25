import { describe, expect, it } from "vitest";
import {
  defaults,
  settingsSchema,
  type Candle,
  type MarketContext,
  type Settings,
} from "../packages/shared/src/index.ts";
import { calculate } from "../packages/indicators/src/index.ts";
import {
  RuleBasedStrategy,
  emaGapShrinking,
} from "../packages/strategy-engine/src/index.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { compareBacktests } from "../packages/backtest-engine/src/index.ts";

/**
 * A flattening decline, tuned against the real indicator maths: at
 * the final candle EMA20 is still below EMA50, the gap has shrunk
 * monotonically for a 26-candle run, RSI crosses back above the
 * default buy line (20.8 -> 33.9 against oversold 30) and the MACD
 * histogram improves. In other words every buy condition lines up
 * except the EMA cross itself — exactly the situation the
 * gap-shrink route exists for.
 */
function tunedCloses(): number[] {
  const closes: number[] = [];
  for (let i = 0; i < 60; i++) closes.push(3.0 - 0.014 * i);
  let p = closes.at(-1)!;
  for (let i = 0; i < 25; i++) {
    p += (2.02 - p) * 0.1;
    closes.push(p);
  }
  for (const r of [0.0005, 0.001, 0.0015, 0.002, 0.0025, 0.006]) {
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
/** Production-shaped context: snapshots calculated from the candles. */
const liveContext = (candles: Candle[], now: number): MarketContext => ({
  candles,
  current: calculate(candles),
  previous: calculate(candles.slice(0, -1)),
  entryPrice: null,
  now,
});
const on: Settings = { ...defaults, emaGapShrinkEnabled: true };

describe("ema gap shrink: settings", () => {
  it("defaults to off with a run of 3, and old records are backfilled", () => {
    expect(defaults.emaGapShrinkEnabled).toBe(false);
    expect(defaults.emaGapShrinkCandles).toBe(3);
    const legacy: Record<string, unknown> = { ...defaults };
    delete legacy.emaGapShrinkEnabled;
    delete legacy.emaGapShrinkCandles;
    const parsed = settingsSchema.parse(legacy);
    expect(parsed.emaGapShrinkEnabled).toBe(false);
    expect(parsed.emaGapShrinkCandles).toBe(3);
  });

  it("rejects runs outside 2..10 and non-integers", () => {
    for (const bad of [1, 11, 2.5, NaN])
      expect(() =>
        settingsSchema.parse({ ...defaults, emaGapShrinkCandles: bad }),
      ).toThrow();
    expect(
      settingsSchema.parse({ ...defaults, emaGapShrinkCandles: 2 })
        .emaGapShrinkCandles,
    ).toBe(2);
    expect(
      settingsSchema.parse({ ...defaults, emaGapShrinkCandles: 10 })
        .emaGapShrinkCandles,
    ).toBe(10);
  });

  it("stored settings without the new fields load with the defaults", () => {
    const db = new BotDatabase(":memory:");
    const legacy: Record<string, unknown> = { ...defaults };
    delete legacy.emaGapShrinkEnabled;
    delete legacy.emaGapShrinkCandles;
    db.set("settings", legacy);
    const loaded = db.settings();
    expect(loaded.emaGapShrinkEnabled).toBe(false);
    expect(loaded.emaGapShrinkCandles).toBe(3);
    db.close();
  });
});

describe("ema gap shrink: the shrink measure", () => {
  const candles = toCandles(tunedCloses());
  it("counts the window as the latest N candles, latest included", () => {
    // The tuned path's trailing strictly-decreasing run is 26
    // candles: a window of 26 fits inside it, 27 reaches the pair
    // that did not shrink.
    expect(emaGapShrinking(candles, 2)).toBe(true);
    expect(emaGapShrinking(candles, 3)).toBe(true);
    expect(emaGapShrinking(candles, 26)).toBe(true);
    expect(emaGapShrinking(candles, 27)).toBe(false);
  });

  it("fails closed on too little data and on a closed gap", () => {
    expect(emaGapShrinking(candles.slice(0, 2), 3)).toBe(false);
    // EMA50 is not yet defined anywhere in this window.
    expect(emaGapShrinking(candles.slice(0, 40), 3)).toBe(false);
    const flat = toCandles(Array.from({ length: 91 }, () => 2));
    expect(emaGapShrinking(flat, 3)).toBe(false);
  });

  it("breaks when the latest candle widens the gap again", () => {
    const dropped = toCandles([
      ...tunedCloses(),
      tunedCloses().at(-1)! * 0.975,
    ]);
    expect(emaGapShrinking(dropped, 3)).toBe(false);
  });
});

describe("ema gap shrink: strategy", () => {
  const candles = toCandles(tunedCloses());
  const now = 1800000000000;

  it("off: the tuned path still waits, exactly as before", async () => {
    const d = await new RuleBasedStrategy(defaults).analyze(
      liveContext(candles, now),
    );
    expect(d.action).toBe("WAIT");
    expect(d.evidence?.selectedRule).toBe("NO_SIGNAL");
    expect(d.evidence?.conditions.emaUp).toBe(false);
    expect(d.evidence?.conditions.emaGapShrinking).toBe(false);
    expect(d.evidence?.thresholds.emaGapShrinkEnabled).toBe(false);
    expect(d.evidence?.thresholds.emaGapShrinkCandles).toBe(3);
  });

  it("on: the same path buys via the shrink route, and says so", async () => {
    const d = await new RuleBasedStrategy(on).analyze(
      liveContext(candles, now),
    );
    expect(d.action).toBe("BUY");
    expect(d.evidence?.selectedRule).toBe("BUY_SIGNAL");
    expect(d.reason).toBe("EMA差縮小・RSI回復・MACD改善");
    expect(d.evidence?.conditions.emaUp).toBe(true);
    expect(d.evidence?.conditions.emaGapShrinking).toBe(true);
    // The cross itself has NOT happened; the evidence must not
    // pretend otherwise anywhere.
    expect(d.evidence?.inputs.current.ema20).toBeLessThan(
      d.evidence!.inputs.current.ema50,
    );
    expect(d.evidence?.thresholds.emaGapShrinkEnabled).toBe(true);
    expect(d.evidence?.thresholds.emaGapShrinkCandles).toBe(3);
  });

  it("on: a gap that widens again on the last candle does not qualify", async () => {
    const dropped = toCandles([
      ...tunedCloses(),
      tunedCloses().at(-1)! * 0.975,
    ]);
    const d = await new RuleBasedStrategy(on).analyze(
      liveContext(dropped, now),
    );
    expect(d.action).toBe("WAIT");
    expect(d.evidence?.conditions.emaUp).toBe(false);
    expect(d.evidence?.conditions.emaGapShrinking).toBe(false);
  });

  /** Hand-made snapshots over two candles (the evidence fixture
   * shape): the shrink series cannot be computed from two candles,
   * which is exactly why the ordinary route must not depend on it. */
  const snapshotContext = (over: {
    current: Partial<MarketContext["current"]>;
    previous: Partial<MarketContext["previous"]>;
  }): MarketContext => {
    const base: MarketContext["current"] = {
      ema20: 2.01,
      ema50: 2,
      rsi: 31,
      macd: 0,
      signal: 0,
      histogram: 0.01,
      atr: 0.1,
      volumeChange: 0,
      priceChange: 0,
    };
    return {
      now,
      entryPrice: null,
      candles: toCandles([2, 2]),
      current: { ...base, ...over.current },
      previous: {
        ...base,
        ema20: 2,
        rsi: 30,
        histogram: 0,
        ...over.previous,
      },
    };
  };

  it("on: an ordinary cross still buys via the cross, not the shrink", async () => {
    const d = await new RuleBasedStrategy(on).analyze(
      snapshotContext({ current: {}, previous: {} }),
    );
    expect(d.action).toBe("BUY");
    expect(d.reason).toBe("EMA上昇・RSI回復・MACD改善");
    expect(d.evidence?.conditions.emaUp).toBe(true);
    expect(d.evidence?.conditions.emaGapShrinking).toBe(false);
  });

  it("on: the sell side is untouched by the shrink route", async () => {
    const d = await new RuleBasedStrategy(on).analyze(
      snapshotContext({
        current: { ema20: 1.99, rsi: 69, histogram: -0.01 },
        previous: { rsi: 70 },
      }),
    );
    expect(d.action).toBe("SELL");
    expect(d.evidence?.selectedRule).toBe("SELL_SIGNAL");
    expect(d.sellPurpose).toBe("STRATEGY_EXIT");
    expect(d.evidence?.conditions.emaGapShrinking).toBe(false);
  });
});

describe("ema gap shrink: telemetry and backtest paths", () => {
  const candles = toCandles(tunedCloses());
  // The last candle closes at (timestamp + 300s); evaluate just
  // after it so the stored evidence passes the freshness checks.
  const evaluatedAt = (candles.at(-1)!.timestamp + 300) * 1000;

  it("telemetry carries the shrink flag from the stored evidence", async () => {
    const db = new BotDatabase(":memory:");
    const decision = await new RuleBasedStrategy(on).analyze(
      liveContext(candles, evaluatedAt),
    );
    db.set("decision", decision);
    const telemetry = new OperationMonitor(db).decisionTelemetry(
      evaluatedAt + 60_000,
    );
    expect(telemetry).not.toBeNull();
    expect(telemetry?.conditions.emaUp).toBe(true);
    expect(telemetry?.conditions.emaGapShrinking).toBe(true);
    db.close();
  });

  it("evidence recorded before the option existed still telemeters", async () => {
    const db = new BotDatabase(":memory:");
    const decision = await new RuleBasedStrategy(on).analyze(
      liveContext(candles, evaluatedAt),
    );
    const legacy = JSON.parse(JSON.stringify(decision)) as typeof decision;
    delete legacy.evidence!.conditions.emaGapShrinking;
    delete legacy.evidence!.thresholds.emaGapShrinkEnabled;
    delete legacy.evidence!.thresholds.emaGapShrinkCandles;
    db.set("decision", legacy);
    const telemetry = new OperationMonitor(db).decisionTelemetry(
      evaluatedAt + 60_000,
    );
    expect(telemetry).not.toBeNull();
    expect(telemetry?.conditions.emaUp).toBe(true);
    expect(telemetry?.conditions.emaGapShrinking).toBe(false);
    db.close();
  });

  it("the backtest engine reaches the same shrink buy", async () => {
    // One extra bar so the backtest's last decision is analysed
    // over the full tuned history (it analyses completed candles
    // only, deciding at each bar from the candles before it).
    const series = toCandles([...tunedCloses(), tunedCloses().at(-1)! * 1.003]);
    const options = {
      start: series[89].timestamp,
      trainEnd: series[88].timestamp,
      end: series.at(-1)!.timestamp,
    };
    const buys = (result: Awaited<ReturnType<typeof compareBacktests>>) =>
      [...result.off.events, ...result.on.events].filter(
        (e) => e.decision.action === "BUY",
      );
    const enabled = await compareBacktests(series, options, on);
    expect(buys(enabled).length).toBeGreaterThan(0);
    expect(buys(enabled)[0].decision.evidence?.conditions.emaGapShrinking).toBe(
      true,
    );
    const disabled = await compareBacktests(series, options, defaults);
    expect(buys(disabled)).toHaveLength(0);
  });
});
