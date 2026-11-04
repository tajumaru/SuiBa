import { describe, expect, it } from "vitest";
import { bookImbalance } from "../packages/market-data/src/deepbook.ts";
import {
  BOOK_TILT_MAX_ATR,
  chartForecast,
} from "../apps/dashboard/src/chartForecast.ts";
import {
  BookImbalanceSampler,
  createBookImbalanceFetcher,
  createBookSampleFetcher,
} from "../apps/worker/src/bookInfo.ts";
import type { Candle } from "../packages/shared/src/index.ts";

const book = (bids: number[][], asks: number[][]) => ({ bids, asks });

describe("bookImbalance", () => {
  it("is 0 for a balanced book and leans toward the heavy side", () => {
    const balanced = book(
      [
        [0.998, 100],
        [0.996, 100],
      ],
      [
        [1.002, 100],
        [1.004, 100],
      ],
    );
    expect(bookImbalance(balanced)).toBeCloseTo(0, 2);
    const bidHeavy = book(
      [
        [0.998, 300],
        [0.996, 300],
      ],
      [
        [1.002, 100],
        [1.004, 100],
      ],
    );
    const v = bookImbalance(bidHeavy);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(0.4);
    expect(v!).toBeLessThan(0.6);
  });

  it("ignores levels outside the band and fails closed when thin", () => {
    const withFarLevels = book(
      [
        [0.998, 100],
        [0.996, 100],
        [0.5, 100000],
      ],
      [
        [1.002, 100],
        [1.004, 100],
        [1.5, 100000],
      ],
    );
    expect(bookImbalance(withFarLevels)).toBeCloseTo(0, 2);
    // One level per side inside the band: too thin to trust.
    expect(
      bookImbalance(
        book(
          [
            [0.998, 100],
            [0.5, 100],
          ],
          [
            [1.002, 100],
            [1.5, 100],
          ],
        ),
      ),
    ).toBeNull();
    expect(bookImbalance(book([], [[1.002, 1], [1.004, 1]]))).toBeNull();
  });
});

describe("BookImbalanceSampler", () => {
  it("keeps the last value for the freshness window only", () => {
    const s = new BookImbalanceSampler();
    const t0 = 1_700_000_000_000;
    expect(s.current(t0)).toBeNull();
    s.observe(0.4, t0);
    expect(s.current(t0 + 60000)).toBe(0.4);
    expect(s.current(t0 + 121000)).toBeNull();
    s.observe(null, t0 + 1000);
    expect(s.current(t0 + 2000)).toBe(0.4);
  });
});

describe("createBookImbalanceFetcher", () => {
  const payload = (bids: string[][], asks: string[][], ts = Date.now()) =>
    new Response(JSON.stringify({ timestamp: ts, bids, asks }), {
      status: 200,
    });
  it("parses indexer levels into an imbalance", async () => {
    const fetchFn = async () =>
      payload(
        [
          ["0.998", "300"],
          ["0.996", "300"],
        ],
        [
          ["1.002", "100"],
          ["1.004", "100"],
        ],
      );
    const read = createBookImbalanceFetcher("SUI_USDC", fetchFn as never);
    const v = await read();
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(0.4);
  });
  it("returns null for stale books and failed reads", async () => {
    const stale = createBookImbalanceFetcher("SUI_USDC", (async () =>
      payload(
        [
          ["0.998", "1"],
          ["0.996", "1"],
        ],
        [
          ["1.002", "1"],
          ["1.004", "1"],
        ],
        Date.now() - 120000,
      )) as never);
    expect(await stale()).toBeNull();
    const broken = createBookImbalanceFetcher("SUI_USDC", (async () => {
      throw new Error("down");
    }) as never);
    expect(await broken()).toBeNull();
  });
});

describe("book samples (levels for the wall watch)", () => {
  const payload = (bids: string[][], asks: string[][], ts = Date.now()) =>
    new Response(JSON.stringify({ timestamp: ts, bids, asks }), {
      status: 200,
    });
  it("the sample fetcher returns the imbalance and top levels", async () => {
    const bids = Array.from({ length: 15 }, (_, i) => [
      String(0.998 - i * 0.001),
      "100",
    ]);
    const asks = Array.from({ length: 15 }, (_, i) => [
      String(1.002 + i * 0.001),
      "100",
    ]);
    const read = createBookSampleFetcher("SUI_USDC", (async () =>
      payload(bids, asks)) as never);
    const sample = await read();
    expect(sample).not.toBeNull();
    expect(sample!.imbalance).toBeCloseTo(0, 1);
    expect(sample!.levels.bids).toHaveLength(12);
    expect(sample!.levels.asks).toHaveLength(12);
    expect(sample!.levels.bids[0]).toEqual([0.998, 100]);
    expect(sample!.levels.at).toBeGreaterThan(0);
  });

  it("the sampler serves levels inside the freshness window only", () => {
    const s = new BookImbalanceSampler();
    const t0 = 1_700_000_000_000;
    expect(s.currentLevels(t0)).toBeNull();
    s.observeSample(
      { imbalance: 0.2, levels: { at: t0, bids: [[0.9, 5]], asks: [[1, 5]] } },
      t0,
    );
    expect(s.current(t0)).toBe(0.2);
    expect(s.currentLevels(t0 + 60000)?.bids).toEqual([[0.9, 5]]);
    expect(s.currentLevels(t0 + 121000)).toBeNull();
    s.observeSample(null, t0 + 1000);
    expect(s.currentLevels(t0 + 2000)?.bids).toEqual([[0.9, 5]]);
  });
});

describe("forecast book tilt", () => {
  const candles: Candle[] = Array.from({ length: 40 }, (_, i) => {
    const t = 1_700_000_000 - (40 - i) * 300;
    const close = 1 + Math.sin(i / 5) * 0.002;
    return {
      timestamp: t,
      timeframe: 300,
      open: close,
      high: close * 1.001,
      low: close * 0.999,
      close,
      volume: 100,
    } as Candle;
  });
  it("leans the drift by up to BOOK_TILT_MAX_ATR and reports the share", () => {
    const plain = chartForecast(candles);
    const tilted = chartForecast(candles, 24, 1);
    expect(plain).not.toBeNull();
    expect(tilted).not.toBeNull();
    expect(plain!.bookTiltPct).toBe(0);
    expect(tilted!.bookTiltPct).toBeGreaterThan(0);
    expect(tilted!.driftPct).toBeGreaterThan(plain!.driftPct);
    // The lean stays modest against the cone's width.
    expect(Math.abs(tilted!.bookTiltPct)).toBeLessThan(
      tilted!.bandPct / 4,
    );
    expect(BOOK_TILT_MAX_ATR).toBe(0.5);
  });
  it("clamps wild imbalance values", () => {
    const a = chartForecast(candles, 24, 1);
    const b = chartForecast(candles, 24, 42);
    expect(b!.bookTiltPct).toBeCloseTo(a!.bookTiltPct, 10);
  });
});
