import { afterEach, expect, it, vi } from "vitest";
import {
  atomic,
  units,
  decimals,
  WAL,
  SUI,
  USDC,
  tradingPair,
  tradingPairs,
  defaults,
  type QuoteResult,
  type Timeframe,
} from "../packages/shared/src/index.ts";
import {
  DeepBookMarketData,
  parseDeepBook,
} from "../packages/market-data/src/deepbook.ts";
import { MarketSelection } from "../packages/market-data/src/selection.ts";
import {
  validEmptyProof,
  reconstructFiveMinutes,
} from "../packages/market-data/src/reconstruction.ts";
import { WalPaperRouter } from "../packages/dex-router/src/pair-router.ts";
import {
  PaperTrading,
  initialPortfolio,
} from "../packages/paper-trading/src/index.ts";
import { reconcileFill } from "../packages/paper-trading/src/reconciliation.ts";
import {
  evaluateSell,
  positionOf,
  profitDefaults,
} from "../packages/profit-guard/src/index.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
import { assessRisk } from "../packages/risk-engine/src/index.ts";
const now = 1800000000000;
afterEach(() => {
  vi.useRealTimers();
  apiAccess.onTransientFailure = () => {};
  apiAccess.onRateLimit = () => {};
});
function quote(buy = true): QuoteResult {
  return {
    id: "fixture",
    from: buy ? USDC : WAL,
    to: buy ? WAL : USDC,
    amountIn: buy ? "5000000" : "2500000000",
    amountOut: buy ? "2500000000" : "6000000",
    minAmountOut: buy ? "2500000000" : "6000000",
    slippage: 0,
    referencePrice: 2,
    priceImpact: 0,
    liquid: true,
    createdAt: now,
    expiresAt: now + 15000,
    route: ["fixture"],
    source: "fixture",
  };
}
function fixture(overrides: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const read = vi.fn(async (path: string): Promise<unknown> => {
    if (path === "/get_pools")
      return [
        {
          pool_name: "WAL_USDC",
          pool_id: tradingPairs.WAL_USDC.poolId,
          base_asset_id: WAL,
          quote_asset_id: USDC,
          base_asset_decimals: 9,
          quote_asset_decimals: 6,
          min_size: 1000000000,
          lot_size: 100000000,
          tick_size: 1,
          ...overrides,
        },
      ];
    if (path.startsWith("/status"))
      return {
        status: "OK",
        current_time_ms: now,
        max_checkpoint_lag: 1,
        max_time_lag_seconds: 1,
      };
    if (path.startsWith("/orderbook"))
      return {
        timestamp: String(now),
        bids: [["1.999", "100"]],
        asks: [["2.001", "100"]],
      };
    const tf: Timeframe = path.includes("15m")
      ? 900
      : path.includes("1h")
        ? 3600
        : 300;
    const last = Math.floor(now / 1000 / tf) * tf - tf;
    return {
      candles: Array.from({ length: 70 }, (_, i) => [
        (last - (69 - i) * tf) * 1000,
        2,
        2.01,
        1.99,
        2,
        100,
      ]),
    };
  });
  return {
    read,
    deep: new DeepBookMarketData(
      () => ({ maxOrder: 5, maxSlippage: 0.003 }),
      read,
      true,
      "WAL_USDC",
    ),
  };
}
it("binds official WAL metadata and exact decimals without changing SUI", () => {
  expect(tradingPair("WAL_USDC")).toBe("WAL_USDC");
  expect(() => tradingPair("WAL_SUI")).toThrow();
  expect(decimals(WAL)).toBe(9);
  expect(decimals(SUI)).toBe(9);
  expect(decimals(USDC)).toBe(6);
  expect(atomic("1.000000001", WAL)).toBe("1000000001");
  expect(units("1000000001", WAL)).toBe(1.000000001);
  expect(atomic("1.000001", USDC)).toBe("1000001");
});
it("loads WAL book and all frames with pair-bound provenance", async () => {
  const { deep, read } = fixture();
  await deep.prepare();
  for (const tf of [300, 900, 3600] as const) {
    const bars = await deep.candles(tf);
    expect(bars).toHaveLength(70);
    expect(bars[0].provenance?.pair).toBe("WAL_USDC");
    expect(bars[0].source).toBe("DeepBook:WAL_USDC:USDC:verified-v1");
  }
  expect(deep.bookParams).toEqual({
    minSize: "1000000000",
    lotSize: "100000000",
    tickSize: "1",
  });
  expect(read.mock.calls.every(([p]) => !p.includes("SUI_USDC"))).toBe(true);
});
it.each([
  { base_asset_id: SUI },
  { base_asset_decimals: 6 },
  { quote_asset_decimals: 9 },
  { pool_id: tradingPairs.SUI_USDC.poolId },
  { lot_size: undefined },
])("rejects mismatched WAL metadata %j", async (invalid) => {
  const { deep } = fixture(invalid);
  await expect(deep.prepare()).rejects.toThrow("MARKET_PAIR_MISMATCH");
});
it("never falls back to SUI when WAL times out", async () => {
  const { deep } = fixture();
  vi.spyOn(deep, "prepare").mockRejectedValue(Error("UPSTREAM_TIMEOUT"));
  const gecko = { candles: vi.fn() };
  const selection = new MarketSelection("deepbook", gecko, deep);
  await expect(selection.frames()).rejects.toThrow("UPSTREAM_TIMEOUT");
  expect(gecko.candles).not.toHaveBeenCalled();
  expect(selection.status().healthy).toBe(false);
});
it("rejects stale WAL books and keeps a separate SUI provider untouched", async () => {
  const { deep } = fixture();
  await deep.prepare();
  vi.setSystemTime(now + 10001);
  expect(() => deep.assertReady(Date.now())).toThrow("STALE_ORDERBOOK");
});
it("rejects SUI reconstruction evidence in a WAL frame", () => {
  const c = parseDeepBook(
    { candles: [[now - 600000, 2, 2, 2, 2, 1]] },
    300,
    now,
    "WAL_USDC",
  );
  expect(() =>
    reconstructFiveMinutes(
      c as never,
      [{ ...c[0], timeframe: 60, source: "DeepBook:SUI_USDC:USDC" }],
      new Map(),
      now,
      now,
      "WAL_USDC",
    ),
  ).toThrow("INVALID_CANDLE");
  expect(
    validEmptyProof(
      {
        source: "DeepBook Indexer",
        pair: "SUI_USDC",
        start: now / 1000 - 600,
        end: now / 1000 - 300,
        fetchedAt: now,
        indexedThrough: now,
        complete: true,
        tradeCount: 0,
        path: "",
      },
      now / 1000 - 600,
      now,
      "WAL_USDC",
    ),
  ).toBe(false);
});
it("rounds WAL buys and sells to live lot size and rejects subminimum orders", async () => {
  const { deep } = fixture();
  await deep.prepare();
  const inner = {
    getQuote: vi.fn(async (r: Parameters<WalPaperRouter["getQuote"]>[0]) => ({
      ...quote(r.from === USDC),
      ...r,
      minAmountOut: r.from === USDC ? "2599999999" : "6000000",
    })),
    validateQuote: vi.fn(async () => true),
  };
  const router = new WalPaperRouter(inner, deep);
  const buy = await router.getQuote(quote());
  expect(buy.minAmountOut).toBe("2500000000");
  expect(await router.validateQuote(buy)).toBe(true);
  const sell = await router.getQuote({
    ...quote(false),
    amountIn: "2599999999",
  });
  expect(sell.amountIn).toBe("2500000000");
  await expect(
    router.getQuote({ ...quote(false), amountIn: "999999999" }),
  ).rejects.toThrow("MIN_ORDER_SIZE");
  expect(
    await router.validateQuote({ ...quote(), minAmountOut: "2500000001" }),
  ).toBe(false);
});
it("accounts for WAL PAPER buy and sales with exact USDC PnL and Profit Guard", () => {
  const paper = new PaperTrading();
  const p = { ...initialPortfolio(now), baseCoin: WAL as typeof WAL };
  const buy = paper.fill("b", "BUY", quote(), p, defaults, now);
  expect(buy.portfolio.sui).toBe(2.5);
  expect(buy.portfolio.costBasisUsdc).toBe("5.045000");
  const sell = paper.fill(
    "s",
    "SELL",
    quote(false),
    buy.portfolio,
    defaults,
    now,
  );
  expect(sell.portfolio.sui).toBe(0);
  expect(sell.trade.realizedProfitUsdc).toBe("0.907000");
  expect(
    reconcileFill(
      buy.portfolio,
      sell.portfolio,
      sell.trade,
      quote(false),
      2,
      defaults,
    ).ok,
  ).toBe(true);
  const report = evaluateSell({
    baseCoin: WAL,
    position: positionOf(buy.portfolio),
    quote: quote(false),
    costs: sell.trade.costs!,
    purpose: "TAKE_PROFIT",
    config: profitDefaults,
    now,
  });
  expect(report.allowed).toBe(true);
  expect(
    evaluateSell({
      position: positionOf(buy.portfolio),
      quote: quote(false),
      costs: sell.trade.costs!,
      purpose: "TAKE_PROFIT",
      config: profitDefaults,
      now,
    }).allowed,
  ).toBe(false);
  expect(() =>
    paper.fill("mixed", "BUY", { ...quote(), to: SUI }, p, defaults, now),
  ).toThrow("MARKET_PAIR_MISMATCH");
});
it("keeps portfolios, settings, history, and engine identity in separate databases", () => {
  const sui = new BotDatabase(":memory:"),
    wal = new BotDatabase(":memory:");
  const market = { candles: vi.fn() };
  const router = { getQuote: vi.fn(), validateQuote: vi.fn() };
  const health = {
    health: vi.fn(),
    status: { healthy: false, checkedAt: 0, failures: 0 },
  };
  const a = new BotEngine(sui, market, router, health);
  const b = new BotEngine(wal, market, router, health, "WAL_USDC");
  wal.set("portfolio", { ...wal.portfolio(), sui: 10, realized: 3 });
  wal.append("paper_trades", "wal", { quantity: 10, timestamp: now });
  wal.updateSettings({ ...wal.settings(), maxOrder: 2 });
  expect(sui.portfolio().sui).toBe(0);
  expect(sui.history("paper_trades")).toEqual([]);
  expect(sui.settings().maxOrder).toBe(5);
  expect(wal.settings().maxOrder).toBe(2);
  expect(a.snapshot().pair).toBe("SUI_USDC");
  expect(b.snapshot().pair).toBe("WAL_USDC");
  expect(() => new BotEngine(wal, market, router, health)).toThrow(
    "MARKET_PAIR_MISMATCH",
  );
  sui.close();
  wal.close();
});
it("RiskEngine rejects a SUI quote against a WAL portfolio", () => {
  const result = assessRisk({
    side: "BUY",
    quote: { ...quote(), to: SUI },
    portfolio: { ...initialPortfolio(now), baseCoin: WAL },
    runtime: { running: true, emergency: false, error: null, lastCandle: null },
    settings: defaults,
    price: 2,
    marketClosedAt: now,
    now,
    duplicate: false,
    pending: 0,
  });
  expect(result).toContain("COIN_DIRECTION");
});

it("WAL timeout closes the execution gate without changing a SUI ledger", async () => {
  const db = new BotDatabase(":memory:"),
    suiDb = new BotDatabase(":memory:");
  const router = { getQuote: vi.fn(), validateQuote: vi.fn() };
  const status = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    {
      candles: async () => {
        throw Error("UPSTREAM_TIMEOUT");
      },
    },
    router,
    { health: async () => status, status },
    "WAL_USDC",
  );
  db.set("runtime", { ...db.runtime(), running: true });
  await engine.tick();
  expect(db.runtime().running).toBe(false);
  expect(db.runtime().error).toBe("UPSTREAM_TIMEOUT");
  expect(db.history("paper_trades")).toHaveLength(0);
  expect(router.getQuote).not.toHaveBeenCalled();
  expect(suiDb.portfolio().sui).toBe(0);
  expect(suiDb.runtime().error).toBeNull();
  db.close();
  suiDb.close();
});
