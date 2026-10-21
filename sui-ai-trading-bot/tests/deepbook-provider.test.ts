import { afterEach, expect, it, vi } from "vitest";
import {
  DeepBookMarketData,
  normalizeDeepBook,
  validateBook,
} from "../packages/market-data/src/deepbook.ts";
import { MarketSelection } from "../packages/market-data/src/selection.ts";
import { calculate } from "../packages/indicators/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  defaults,
  SUI,
  USDC,
  type Timeframe,
  type Candle,
} from "../packages/shared/src/index.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
afterEach(() => {
  vi.restoreAllMocks();
  apiAccess.onTransientFailure = () => {};
  apiAccess.onRateLimit = () => {};
});
function bars(tf: Timeframe, source = "DeepBook:SUI_USDC:USDC"): Candle[] {
  const closed = Math.floor(Date.now() / 1000 / tf) * tf - tf;
  return Array.from({ length: 70 }, (_, i) => ({
    timestamp: closed - (69 - i) * tf,
    open: 1,
    high: 1.01,
    low: 0.99,
    close: 1,
    volume: 100,
    timeframe: tf,
    source,
  }));
}
function raw(tf: Timeframe) {
  return {
    candles: bars(tf)
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
}
function book() {
  return {
    timestamp: String(Date.now()),
    bids: [[".9999", "100"]],
    asks: [["1.0001", "100"]],
  };
}
const limits = () => ({ maxOrder: 5, maxSlippage: 0.003 });
function deep() {
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
        status: "OK",
        current_time_ms: Date.now(),
        max_checkpoint_lag: 1,
        max_time_lag_seconds: 1,
      };
    if (path.startsWith("/orderbook")) return book();
    return raw(
      path.includes("5m") && !path.includes("15m")
        ? 300
        : path.includes("15m")
          ? 900
          : 3600,
    );
  });
  return { provider: new DeepBookMarketData(limits, read), read };
}
function gecko() {
  return {
    candles: vi.fn(async (tf: Timeframe) =>
      bars(tf, "GeckoTerminal:test:USDC"),
    ),
  };
}
it("reads pair, status, book and all three validated frames without credentials", async () => {
  const d = deep(),
    g = gecko(),
    p = new MarketSelection("auto", g, d.provider);
  const frames = await p.frames();
  expect(Object.keys(frames)).toHaveLength(3);
  expect(g.candles).not.toHaveBeenCalled();
  expect(p.status()).toMatchObject({
    source: "DeepBook",
    fallback: false,
    healthy: true,
  });
  expect(Object.values(calculate(frames[300])).every(Number.isFinite)).toBe(
    true,
  );
  expect(d.read).toHaveBeenCalledTimes(6);
  p.assertReady(Date.now());
});
for (const code of [
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_HTTP_502",
  "UPSTREAM_HTTP_503",
  "UPSTREAM_HTTP_504",
  "INDEXER_DELAYED",
  "CANDLE_GAP",
  "INSUFFICIENT_CANDLES",
])
  it("falls back the entire series after " + code, async () => {
    const d = deep(),
      g = gecko();
    vi.spyOn(d.provider, "prepare").mockRejectedValue(new Error(code));
    const p = new MarketSelection("auto", g, d.provider);
    const frames = await p.frames();
    expect(g.candles).toHaveBeenCalledTimes(3);
    expect(
      Object.values(frames)
        .flat()
        .every((x) => x.source.startsWith("GeckoTerminal")),
    ).toBe(true);
    expect(p.status()).toMatchObject({
      source: "GeckoTerminal",
      fallback: true,
      reason: code,
    });
  });
for (const code of [
  "UPSTREAM_HTTP_429",
  "API_BACKOFF",
  "API_CANCELLED",
  "SPREAD_TOO_WIDE",
  "THIN_ORDERBOOK",
  "STALE_ORDERBOOK",
  "MARKET_PAIR_MISMATCH",
])
  it("does not bypass safety using fallback for " + code, async () => {
    const d = deep(),
      g = gecko();
    vi.spyOn(d.provider, "prepare").mockRejectedValue(new Error(code));
    await expect(
      new MarketSelection("auto", g, d.provider).frames(),
    ).rejects.toThrow(code);
    expect(g.candles).not.toHaveBeenCalled();
  });
it("rejects both providers failing and never uses previous data as fallback", async () => {
  const d = deep(),
    g = gecko(),
    p = new MarketSelection("auto", g, d.provider);
  await p.frames();
  vi.spyOn(d.provider, "prepare").mockRejectedValue(
    new Error("UPSTREAM_TIMEOUT"),
  );
  g.candles.mockRejectedValue(new Error("UPSTREAM_HTTP_503"));
  await expect(p.frames()).rejects.toThrow("UPSTREAM_HTTP_503");
  expect(p.status().healthy).toBe(false);
  expect(() => p.assertReady(Date.now())).toThrow("MARKET_UNAVAILABLE");
});
it("keeps strict DeepBook mode strict", async () => {
  const d = deep(),
    g = gecko();
  vi.spyOn(d.provider, "prepare").mockRejectedValue(
    new Error("UPSTREAM_TIMEOUT"),
  );
  await expect(
    new MarketSelection("deepbook", g, d.provider).frames(),
  ).rejects.toThrow();
  expect(g.candles).not.toHaveBeenCalled();
});
it("keeps the existing default Gecko mode independent of DeepBook", async () => {
  const d = deep(),
    g = gecko();
  await new MarketSelection("geckoterminal", g, d.provider).frames();
  expect(d.read).not.toHaveBeenCalled();
});
it("rejects a different quote coin even when the pool name matches", async () => {
  const d = new DeepBookMarketData(limits, async () => [
    {
      pool_name: "SUI_USDC",
      base_asset_id: SUI,
      quote_asset_id: SUI,
      base_asset_decimals: 9,
      quote_asset_decimals: 6,
    },
  ]);
  await expect(d.prepare()).rejects.toThrow("MARKET_PAIR_MISMATCH");
});
it("normalizes milliseconds and seconds identically", () => {
  const r = raw(300);
  expect(normalizeDeepBook(r, 300, Date.now())).toEqual(
    normalizeDeepBook(
      { candles: r.candles.map((x) => [x[0] / 1000, ...x.slice(1)]) },
      300,
      Date.now(),
    ),
  );
});
it("excludes unfinished candles", () => {
  const r = raw(300);
  r.candles.unshift([
    Math.floor(Date.now() / 300000) * 300000,
    1,
    1.01,
    0.99,
    1,
    100,
  ]);
  expect(normalizeDeepBook(r, 300, Date.now())).toHaveLength(70);
});
it("refuses gaps rather than filling or shortening them", () => {
  const r = raw(300);
  r.candles.splice(30, 1);
  expect(() => normalizeDeepBook(r, 300, Date.now())).toThrow("CANDLE_GAP");
});
it("refuses stale candles", () =>
  expect(() => normalizeDeepBook(raw(300), 300, Date.now() + 900000)).toThrow(
    "STALE_CANDLES",
  ));
it("refuses insufficient candles instead of computing indicators", () =>
  expect(() =>
    normalizeDeepBook(
      { candles: raw(300).candles.slice(0, 60) },
      300,
      Date.now(),
    ),
  ).toThrow("INSUFFICIENT_CANDLES"));
for (const [label, change, expected] of [
  [
    "stale",
    (r: any) => (r.timestamp = String(Date.now() - 10001)),
    "STALE_ORDERBOOK",
  ],
  [
    "future",
    (r: any) => (r.timestamp = String(Date.now() + 5001)),
    "STALE_ORDERBOOK",
  ],
  ["wide", (r: any) => (r.asks[0][0] = "1.1"), "SPREAD_TOO_WIDE"],
  ["thin", (r: any) => (r.bids[0][1] = ".001"), "THIN_ORDERBOOK"],
  ["crossed", (r: any) => (r.bids[0][0] = "1.01"), "INVALID_ORDERBOOK"],
  ["nonfinite", (r: any) => (r.asks[0][1] = "Infinity"), "INVALID_ORDERBOOK"],
] as const)
  it("rejects " + label + " order book", () => {
    const r = book();
    change(r);
    expect(() => validateBook(r, Date.now(), 5, 0.003)).toThrow(expected);
  });
it("rechecks book age and tightened size limits immediately before filling", async () => {
  const d = deep();
  await d.provider.prepare();
  expect(() => d.provider.assertReady(Date.now() + 11000)).toThrow(
    "STALE_ORDERBOOK",
  );
});
it("stops PAPER on source change, persists both histories, and does not auto resume", async () => {
  const db = new BotDatabase(":memory:");
  let source = "GeckoTerminal:test:USDC";
  const market = {
    candles: async (tf: Timeframe) => bars(tf, source),
    frames: async () =>
      Object.fromEntries(
        ([300, 900, 3600] as const).map((tf) => [tf, bars(tf, source)]),
      ),
  };
  const engine = new BotEngine(
    db,
    market,
    {
      getQuote: async () => {
        throw Error("UNEXPECTED_QUOTE");
      },
      validateQuote: async () => true,
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
  db.set("runtime", { ...db.runtime(), running: true });
  await engine.tick();
  expect(db.runtime().error).toBeNull();
  source = "DeepBook:SUI_USDC:USDC";
  await engine.tick();
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "MARKET_SOURCE_CHANGED",
  });
  expect(engine.snapshot().price).toBeNull();
  expect(engine.snapshot().indicators).toBeNull();
  await engine.tick();
  expect(db.runtime().running).toBe(false);
  expect(db.history("paper_trades")).toHaveLength(0);
  expect(db.candles().every((x) => x.source === source)).toBe(true);
  db.close();
});
it("persists WAIT and stops PAPER when indicators lack required history", async () => {
  const db = new BotDatabase(":memory:");
  db.set("runtime", { ...db.runtime(), running: true });
  const engine = new BotEngine(
    db,
    {
      candles: async () => {
        throw Error("INSUFFICIENT_CANDLES");
      },
    },
    {
      getQuote: async () => {
        throw Error("UNEXPECTED_QUOTE");
      },
      validateQuote: async () => true,
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
  expect(db.runtime()).toMatchObject({
    running: false,
    error: "INSUFFICIENT_CANDLES",
  });
  expect(db.history("paper_trades")).toHaveLength(0);
  db.close();
});

it("rechecks tightened notional limits against cached book", async () => {
  let maxOrder = 5;
  const fixture = deep();
  const d = new DeepBookMarketData(
    () => ({ maxOrder, maxSlippage: 0.003 }),
    fixture.read,
  );
  await d.prepare();
  maxOrder = 200;
  expect(() => d.assertReady(Date.now())).toThrow("THIN_ORDERBOOK");
});
