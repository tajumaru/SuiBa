import { expect, it } from "vitest";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import { defaults, type MarketContext } from "../packages/shared/src/index.ts";
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
  current: {
    ema20: 2.01,
    ema50: 2,
    rsi: 31,
    macd: 0,
    signal: 0,
    histogram: 0.01,
    atr: 0.1,
    volumeChange: 0,
    priceChange: 0,
  },
  previous: {
    ema20: 2,
    ema50: 2,
    rsi: 30,
    macd: 0,
    signal: 0,
    histogram: 0,
    atr: 0.1,
    volumeChange: 0,
    priceChange: 0,
  },
});
it.each([
  "BUY_SIGNAL",
  "SELL_SIGNAL",
  "VOLUME_REJECT",
  "NO_SIGNAL",
  "STOP_LOSS",
  "TAKE_PROFIT",
])(
  "records the actual %s rule with exact inputs and thresholds",
  async (rule) => {
    const c = context();
    if (rule === "SELL_SIGNAL") {
      c.current.ema20 = 1.99;
      c.previous.rsi = 70;
      c.current.rsi = 69;
      c.current.histogram = -0.01;
    }
    if (rule === "VOLUME_REJECT") c.candles[1].volume = 0;
    if (rule === "NO_SIGNAL") c.previous.rsi = 31;
    if (rule === "STOP_LOSS") c.entryPrice = 3;
    if (rule === "TAKE_PROFIT") c.entryPrice = 1;
    const d = await new RuleBasedStrategy(defaults).analyze(c);
    expect(d.action).toBe(
      rule === "BUY_SIGNAL"
        ? "BUY"
        : ["NO_SIGNAL", "VOLUME_REJECT"].includes(rule)
          ? "WAIT"
          : "SELL",
    );
    expect(d.evidence).toMatchObject({
      version: 1,
      evaluatedAt: c.now,
      candleTimestamp: c.candles[1].timestamp,
      selectedRule: rule,
      inputs: {
        entryPrice: c.entryPrice,
        current: c.current,
        previous: c.previous,
      },
      thresholds: {
        oversold: defaults.oversold,
        overbought: defaults.overbought,
        maxVolumeChange: defaults.maxVolumeChange,
      },
    });
    if (rule === "VOLUME_REJECT")
      expect(d.evidence?.conditions.latestVolumePositive).toBe(false);
    if (rule === "NO_SIGNAL")
      expect(d.evidence?.conditions.rsiRecovery).toBe(false);
  },
);
it("keeps protective exits ahead of the volume filter", async () => {
  const c = context();
  c.entryPrice = 3;
  c.candles[1].volume = 0;
  const d = await new RuleBasedStrategy(defaults).analyze(c);
  expect(d.sellPurpose).toBe("STOP_LOSS");
  expect(d.evidence?.selectedRule).toBe("STOP_LOSS");
  expect(d.evidence?.conditions.latestVolumePositive).toBe(false);
});
