import { describe, expect, it } from "vitest";
import {
  LongTermSampler,
  createDailyCandleFetcher,
  parseDailyCandles,
} from "../apps/worker/src/longTerm.ts";

const DAY = 86400;
const NOW = Math.floor(Date.UTC(2026, 10, 5, 12) / 1000);

describe("parseDailyCandles", () => {
  it("maps Coinbase's [time, low, high, open, close, volume] order", () => {
    const rows = [
      [NOW - DAY, 0.9, 1.1, 1.0, 1.05, 123],
      [NOW - 2 * DAY, 0.8, 1.0, 0.95, 0.9, 100],
    ];
    const out = parseDailyCandles(rows, NOW);
    expect(out).toHaveLength(2);
    expect(out[0].timestamp).toBe(NOW - 2 * DAY); // oldest first
    expect(out[1]).toMatchObject({ open: 1.0, high: 1.1, low: 0.9, close: 1.05 });
  });

  it("drops the running day, malformed rows and duplicates", () => {
    const rows = [
      [NOW, 0.9, 1.1, 1.0, 1.05, 1], // unfinished
      [NOW - DAY, 0.9, 1.1, 1.0, 1.05, 1],
      [NOW - DAY, 0.9, 1.1, 1.0, 1.06, 1], // duplicate time: last wins
      ["x", 0.9, 1.1, 1.0, 1.05, 1],
      [NOW - 2 * DAY, -1, 1.1, 1.0, 1.05, 1],
    ];
    const out = parseDailyCandles(rows, NOW);
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(1.06);
    expect(parseDailyCandles("nope", NOW)).toEqual([]);
  });
});

describe("createDailyCandleFetcher", () => {
  const page = (endIso: string) => {
    const end = Math.floor(Date.parse(endIso) / 1000);
    return Array.from({ length: 40 }, (_, k) => [
      end - (k + 1) * DAY,
      0.9, 1.1, 1.0, 1.05, 10,
    ]);
  };

  it("walks back in pages and merges a two-year span", async () => {
    const urls: string[] = [];
    const fetcher = createDailyCandleFetcher(
      "SUI-USD",
      730,
      async (url) => {
        urls.push(url);
        const end = /end=([^&]+)/.exec(url)![1];
        return page(decodeURIComponent(end));
      },
      () => NOW * 1000,
    );
    const out = await fetcher();
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain("products/SUI-USD/candles?granularity=86400");
    expect(out).not.toBeNull();
    expect(out!.length).toBe(120);
    expect(out![0].timestamp).toBeLessThan(out!.at(-1)!.timestamp);
  });

  it("returns null when a page fails or the series is thin", async () => {
    const failing = createDailyCandleFetcher(
      "SUI-USD", 730,
      async () => { throw new Error("boom"); },
      () => NOW * 1000,
    );
    expect(await failing()).toBeNull();
    const thin = createDailyCandleFetcher(
      "SUI-USD", 730,
      async () => [[NOW - DAY, 0.9, 1.1, 1.0, 1.05, 1]],
      () => NOW * 1000,
    );
    expect(await thin()).toBeNull();
  });
});

describe("LongTermSampler", () => {
  it("keeps the last good series through failures", async () => {
    const sampler = new LongTermSampler();
    expect(sampler.current()).toBeNull();
    const good = parseDailyCandles(
      Array.from({ length: 40 }, (_, k) => [
        NOW - (k + 1) * DAY, 0.9, 1.1, 1.0, 1.05, 1,
      ]),
      NOW,
    );
    sampler.observe(good);
    expect(sampler.current()).toBe(good);
    sampler.observe(null);
    sampler.observe([]);
    expect(sampler.current()).toBe(good);
  });
});
