import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  reconstructFiveMinutes,
  type EmptyTradeProof,
  type MarketCandle,
} from "../packages/market-data/src/reconstruction.ts";
import {
  DeepBookMarketData,
  parseDeepBook,
} from "../packages/market-data/src/deepbook.ts";
import { validateCandles } from "../packages/market-data/src/validation.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
import { SUI, USDC, type Candle } from "../packages/shared/src/index.ts";
afterEach(() => {
  vi.restoreAllMocks();
  apiAccess.onTransientFailure = () => {};
  apiAccess.onRateLimit = () => {};
});
const now = 1792574400000,
  first = 1792548000;
const rows = (): Candle[] =>
  Array.from({ length: 70 }, (_, i) => ({
    timestamp: first + i * 300,
    open: 1,
    high: 1.1,
    low: 0.9,
    close: 1,
    volume: 100,
    timeframe: 300,
    source: "DeepBook:SUI_USDC:USDC",
  }));
// Use a fixed evaluation time after every fixture candle closes.
const evaluated = (first + 70 * 300) * 1000 + 120000;
const t = first + 20 * 300;
const hole = () => rows().filter((x) => x.timestamp !== t);
const proof = (): EmptyTradeProof => ({
  source: "DeepBook Indexer",
  pair: "SUI_USDC",
  start: t,
  end: t + 300,
  fetchedAt: evaluated,
  indexedThrough: evaluated,
  complete: true,
  tradeCount: 0,
  path:
    "/trades/SUI_USDC?start_time=" +
    t +
    "&end_time=" +
    (t + 300) +
    "&limit=1000",
});
const minutes = (): MarketCandle[] =>
  Array.from({ length: 5 }, (_, i) => ({
    timestamp: t + i * 60,
    timeframe: 60,
    source: "DeepBook:SUI_USDC:USDC",
    open: 1 + i * 0.001,
    high: 1.01 + i * 0.001,
    low: 0.99 + i * 0.001,
    close: 1.002 + i * 0.001,
    volume: 10 + i,
  }));
it("keeps complete raw five-minute history unchanged and marks original provenance", () => {
  const c = rows(),
    r = reconstructFiveMinutes(c, [], new Map(), evaluated);
  expect(r.quality).toMatchObject({
    missing: 0,
    reconstructed: 0,
    unresolved: 0,
  });
  expect(r.candles.map(({ source, provenance, ...x }) => x)).toEqual(
    c.map(({ source, provenance, ...x }) => x),
  );
});
it("creates a zero-volume candle only from complete bounded official empty-trade evidence", () => {
  const r = reconstructFiveMinutes(
    hole(),
    [],
    new Map([[t, proof()]]),
    evaluated,
  );
  expect(r.quality).toMatchObject({
    missing: 1,
    reconstructed: 1,
    unresolved: 0,
  });
  expect(r.candles.find((x) => x.timestamp === t)).toMatchObject({
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 0,
    provenance: { origin: "NO_INDEXED_TRADES" },
  });
});
it("does not create a zero candle when any trade exists", () => {
  const p = { ...proof(), tradeCount: 1 };
  expect(
    reconstructFiveMinutes(hole(), [], new Map([[t, p]]), evaluated).quality
      .unresolved,
  ).toBe(1);
});
it("rebuilds OHLCV only from all five exact closed one-minute candles", () => {
  const r = reconstructFiveMinutes(hole(), minutes(), new Map(), evaluated),
    c = r.candles.find((x) => x.timestamp === t)!;
  expect(c).toMatchObject({
    open: 1,
    high: 1.014,
    low: 0.99,
    close: 1.006,
    volume: 60,
    provenance: { origin: "ONE_MINUTE_AGGREGATE" },
  });
  expect(r.quality.unresolved).toBe(0);
});
it("never fills a missing minute even when an empty-trade proof contradicts existing minutes", () => {
  expect(
    reconstructFiveMinutes(
      hole(),
      minutes().slice(0, 4),
      new Map([[t, proof()]]),
      evaluated,
    ).quality.unresolved,
  ).toBe(1);
});
for (const [label, change] of [
  ["incomplete response", (p: EmptyTradeProof) => (p.complete = false)],
  [
    "indexer behind range",
    (p: EmptyTradeProof) => (p.indexedThrough = t * 1000),
  ],
  ["expired proof", (p: EmptyTradeProof) => (p.fetchedAt -= 3600001)],
  ["future proof", (p: EmptyTradeProof) => (p.fetchedAt += 1)],
  ["different interval", (p: EmptyTradeProof) => (p.end += 300)],
  [
    "wrong API unit",
    (p: EmptyTradeProof) =>
      (p.path = p.path.replace(String(t), String(t * 1000))),
  ],
] as const)
  it("refuses empty proof with " + label, () => {
    const p = proof();
    change(p);
    expect(
      reconstructFiveMinutes(hole(), [], new Map([[t, p]]), evaluated).quality
        .unresolved,
    ).toBe(1);
  });
it("rejects duplicate five-minute candles", () =>
  expect(() =>
    reconstructFiveMinutes([...rows(), rows()[0]], [], new Map(), evaluated),
  ).toThrow("INVALID_CANDLE"));
it("rejects duplicate minutes", () =>
  expect(() =>
    reconstructFiveMinutes(
      hole(),
      [...minutes(), minutes()[0]],
      new Map(),
      evaluated,
    ),
  ).toThrow("INVALID_CANDLE"));
it("rejects invalid minute boundaries", () => {
  const m = minutes();
  m[0].timestamp++;
  expect(() => reconstructFiveMinutes(hole(), m, new Map(), evaluated)).toThrow(
    "INVALID_CANDLE",
  );
});
it("rejects different markets", () => {
  const m = minutes();
  m[0].source = "GeckoTerminal:other";
  expect(() => reconstructFiveMinutes(hole(), m, new Map(), evaluated)).toThrow(
    "INVALID_CANDLE",
  );
});
it("leaves unresolved gaps invalid under the unchanged validator", () => {
  const r = reconstructFiveMinutes(hole(), [], new Map(), evaluated);
  expect(() => validateCandles(r.candles, 300, evaluated)).toThrow(
    "CANDLE_GAP",
  );
});
it("reproduces all 43 historical empty buckets and preserves all 999 source candles", () => {
  const h = JSON.parse(
      readFileSync("docs/evidence/gaps/historical-5m.json", "utf8"),
    ),
    x = JSON.parse(readFileSync("docs/evidence/gaps/cross-check.json", "utf8"));
  const raw = parseDeepBook(h.raw, 300, h.to * 1000) as Candle[],
    m = parseDeepBook({ candles: x.minutes }, 60, h.to * 1000),
    n = x.completedAt;
  const ps = new Map<number, EmptyTradeProof>(
    x.gaps.map((g: any) => {
      const path =
        "/trades/SUI_USDC?start_time=" +
        g.timestamp +
        "&end_time=" +
        (g.timestamp + 300) +
        "&limit=1000";
      return [
        g.timestamp,
        {
          source: "DeepBook Indexer",
          pair: "SUI_USDC",
          start: g.timestamp,
          end: g.timestamp + 300,
          fetchedAt: x.queries.find((q: any) => q.path === path).observedAt,
          indexedThrough: x.finalStatus.pipelines.find(
            (p: any) => p.pipeline === "order_fill" && !p.is_backfill,
          ).indexed_timestamp_ms,
          complete: g.queryComplete,
          tradeCount: g.trades.length,
          path,
        },
      ];
    }),
  );
  const r = reconstructFiveMinutes(raw, m, ps, n);
  expect(r.quality).toMatchObject({
    missing: 43,
    reconstructed: 43,
    unresolved: 0,
    origins: { ORIGINAL: 999, NO_INDEXED_TRADES: 43, ONE_MINUTE_AGGREGATE: 0 },
  });
  expect(r.candles).toHaveLength(1042);
  for (const c of raw) {
    const repaired = r.candles.find((x) => x.timestamp === c.timestamp)!;
    expect([
      repaired.open,
      repaired.high,
      repaired.low,
      repaired.close,
      repaired.volume,
    ]).toEqual([c.open, c.high, c.low, c.close, c.volume]);
  }
  validateCandles(r.candles, 300, h.to * 1000);
});
function runtimeFixture(tradesExist = false, delayed = false) {
  const current = Math.floor(Date.now() / 300000) * 300 - 300,
    raw = rows().map((x, i) => ({ ...x, timestamp: current - (69 - i) * 300 })),
    missing = raw[20].timestamp;
  const read = vi.fn(async (path: string): Promise<unknown> => {
    if (path === "/get_pools")
      return [
        {
          pool_name: "SUI_USDC",
          base_asset_id: SUI,
          quote_asset_id: USDC,
          base_asset_decimals: 9,
          quote_asset_decimals: 6,
        },
      ];
    if (path.startsWith("/status"))
      return {
        status: delayed ? "UNHEALTHY" : "OK",
        current_time_ms: Date.now(),
        max_checkpoint_lag: 1,
        max_time_lag_seconds: 1,
        pipelines: [
          {
            pipeline: "order_fill",
            indexed_timestamp_ms: Date.now(),
            is_backfill: false,
          },
        ],
      };
    if (path.startsWith("/orderbook"))
      return {
        timestamp: String(Date.now()),
        bids: [[".9999", "100"]],
        asks: [["1.0001", "100"]],
      };
    if (path.startsWith("/trades"))
      return tradesExist ? [{ timestamp: missing * 1000 + 1 }] : [];
    if (path.includes("interval=1m")) return { candles: [] };
    return {
      candles: raw
        .filter((x) => x.timestamp !== missing)
        .map((x) => [
          x.timestamp * 1000,
          x.open,
          x.high,
          x.low,
          x.close,
          x.volume,
        ])
        .reverse(),
    };
  });
  return {
    provider: new DeepBookMarketData(
      () => ({ maxOrder: 5, maxSlippage: 0.003 }),
      read,
      true,
    ),
    read,
  };
}
it("integrates opt-in verified reconstruction and refreshes the book afterwards", async () => {
  const x = runtimeFixture();
  await x.provider.prepare();
  const r = await x.provider.candles(300);
  expect(r).toHaveLength(70);
  expect(x.provider.quality()[300].unresolved).toBe(0);
  await x.provider.finalize();
  x.provider.assertReady(Date.now());
  expect(
    x.read.mock.calls.filter((x) => x[0].startsWith("/orderbook")),
  ).toHaveLength(3);
  await x.provider.candles(300);
  expect(
    x.read.mock.calls.filter((x) => x[0].startsWith("/trades")),
  ).toHaveLength(1);
});
it("does not use indexed-through status when the indexer is delayed", async () => {
  const x = runtimeFixture(false, true);
  await expect(x.provider.prepare()).rejects.toThrow("INDEXER_DELAYED");
  expect(x.read.mock.calls.some((x) => x[0].startsWith("/trades"))).toBe(false);
});
it("persists WAIT, quality and PAPER safe stop when a trade contradicts an empty candle", async () => {
  const x = runtimeFixture(true),
    db = new BotDatabase(":memory:");
  await x.provider.prepare();
  db.set("runtime", { ...db.runtime(), running: true });
  const engine = new BotEngine(
    db,
    {
      candles: (tf) => x.provider.candles(tf),
      status: () => ({
        configured: "deepbook",
        source: "DeepBook",
        healthy: false,
        fallback: false,
        lastSuccessAt: null,
        latencyMs: null,
        reason: "CANDLE_GAP",
        bookAt: null,
        bid: null,
        ask: null,
        spread: null,
        quality: x.provider.quality(),
      }),
    },
    {
      getQuote: async () => {
        throw Error("NO_TRADES");
      },
      validateQuote: async () => false,
    },
    {
      health: async () => ({
        healthy: true,
        checkedAt: Date.now(),
        failures: 0,
      }),
      status: { healthy: true, checkedAt: Date.now(), failures: 0 },
    },
  );
  await engine.tick();
  expect(db.get<{ action: string }>("decision")?.action).toBe("WAIT");
  expect(db.runtime()).toMatchObject({ running: false, error: "CANDLE_GAP" });
  expect(
    db.get<Record<number, { unresolved: number }>>("market_quality")?.[300]
      .unresolved,
  ).toBe(1);
  expect(db.history("paper_trades")).toHaveLength(0);
  db.close();
});
