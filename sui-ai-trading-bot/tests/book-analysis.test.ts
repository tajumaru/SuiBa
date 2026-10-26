import { expect, it } from "vitest";
import { analyzeBook } from "../packages/market-data/src/book-analysis.ts";
import { validateBook } from "../packages/market-data/src/deepbook.ts";
import {
  RuleBasedStrategy,
  BookAwareStrategy,
} from "../packages/strategy-engine/src/index.ts";
import { compareStrategies } from "../packages/backtest-engine/src/strategy-comparison.ts";
import {
  defaults,
  type MarketContext,
  type Candle,
} from "../packages/shared/src/index.ts";
const now = 1800000000000;
const raw = () => ({
  timestamp: now,
  bids: [
    ["1.999", "30"],
    ["1.998", "10"],
  ],
  asks: [
    ["2.001", "10"],
    ["2.002", "10"],
  ],
});
const book = () => validateBook(raw(), now, 0, 0.003);
const features = () => analyzeBook(book(), now, [1, 3, 100]);
const context = (): MarketContext => ({
  now,
  entryPrice: null,
  candles: [0, 1].map((i) => ({
    timestamp: now / 1000 - 600 + i * 300,
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
it("computes symmetric-window notional depth, imbalance, bps and quantity impact", () => {
  const f = features();
  expect(f.bidDepthUsdc).toBeCloseTo(79.95);
  expect(f.askDepthUsdc).toBeCloseTo(40.03);
  expect(f.imbalance).toBeCloseTo((79.95 - 40.03) / 119.98);
  expect(f.spreadBps).toBeCloseTo(10);
  expect(f.estimates[0].buyBps).toBeCloseTo(5);
  expect(f.estimates[2].buyBps).toBeNull();
  expect(f.estimates[2].sellBps).toBeNull();
});
it.each(["stale", "future", "nan", "crossed", "duplicate", "empty"])(
  "rejects %s books",
  (kind) => {
    const b = book();
    if (kind === "stale") b.timestamp -= 10001;
    if (kind === "future") b.timestamp += 1;
    if (kind === "nan") b.bids[0][1] = NaN;
    if (kind === "crossed") b.bids[0][0] = 3;
    if (kind === "duplicate") b.bids[1][0] = b.bids[0][0];
    if (kind === "empty") b.asks = [];
    expect(() => analyzeBook(b, now, [1])).toThrow();
  },
);
it("keeps old actions and rules while exposing uncalibrated components", async () => {
  const c = context(),
    strategy = new RuleBasedStrategy(defaults);
  const before = await strategy.analyze(c),
    after = await strategy.analyze({ ...c, book: features() });
  expect(before.action).toBe("BUY");
  expect(after.action).toBe(before.action);
  expect(after.evidence).toEqual(before.evidence);
  expect(after.scoreEvidence?.kind).toBe("UNCALIBRATED_SCORE");
  expect(after.confidence).toBe(after.scoreEvidence?.score);
  expect(after.confidence).toBeGreaterThanOrEqual(0);
  expect(after.confidence).toBeLessThanOrEqual(1);
});
it.each([
  null,
  { ...features(), timestamp: now - 10001 },
  { ...features(), imbalance: NaN },
])(
  "blocks new strategy orders with missing or invalid features",
  async (book) => {
    expect(
      (await new BookAwareStrategy(defaults).analyze({ ...context(), book }))
        .action,
    ).toBe("WAIT");
  },
);
it("requires supporting imbalance and sufficient size; preserves protective exits", async () => {
  const s = new BookAwareStrategy(defaults),
    c = context();
  expect((await s.analyze({ ...c, book: features() })).action).toBe("BUY");
  expect(
    (await s.analyze({ ...c, book: { ...features(), imbalance: -0.5 } }))
      .reason,
  ).toBe("BOOK_IMBALANCE");
  expect((await s.analyze({ ...c, entryPrice: 3 })).sellPurpose).toBe(
    "STOP_LOSS",
  );
});
it("reports missing history without future backfill and keeps causal replay", async () => {
  const candles: Candle[] = Array.from({ length: 100 }, (_, i) => ({
    timestamp: now / 1000 + i * 300,
    timeframe: 300,
    source: "SYNTHETIC_TEST",
    open: 2,
    close: 2,
    high: 2.01,
    low: 1.99,
    volume: 100000,
  }));
  const options = {
    start: candles[65].timestamp,
    end: candles[99].timestamp,
    trainEnd: candles[64].timestamp,
  };
  const empty = await compareStrategies(candles, options, []);
  const future = await compareStrategies(candles, options, [
    { observedAt: now + 100 * 300000, healthy: true, book: book() },
  ]);
  expect(empty.coverage.covered).toBe(0);
  expect(empty.coverage.evaluated).toBe(35);
  expect(future.candidate).toEqual(empty.candidate);
  expect(empty.baseline.summary.netProfitUsdc).toBe(0);
  await expect(
    compareStrategies(candles, options, [
      { observedAt: now, healthy: false, book: null },
      { observedAt: now - 1, healthy: false, book: null },
    ]),
  ).rejects.toThrow("CHRONOLOGICAL");
});

it("rejects thin size and wide spread without relaxing the base rules", async () => {
  const c = context(),
    s = new BookAwareStrategy(defaults);
  const f = features();
  expect(
    (await s.analyze({ ...c, book: { ...f, estimates: [] } })).reason,
  ).toBe("BOOK_SLIPPAGE_OR_DEPTH");
  expect(
    (await s.analyze({ ...c, book: { ...f, spreadBps: 100 } })).reason,
  ).toBe("BOOK_SPREAD");
  expect(
    (
      await s.analyze({
        ...c,
        book: {
          ...f,
          estimates: f.estimates.map((e) => ({ ...e, buyBps: NaN })),
        },
      })
    ).action,
  ).toBe("WAIT");
});
