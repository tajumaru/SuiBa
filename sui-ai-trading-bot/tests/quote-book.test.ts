import { expect, it } from "vitest";
import { quoteBookReason } from "../packages/market-data/src/quote-book.ts";
import {
  SUI,
  WAL,
  USDC,
  type QuoteResult,
} from "../packages/shared/src/index.ts";
import type { MarketStatus } from "../packages/market-data/src/provider.ts";
const now = 100000;
const market = {
  source: "DeepBook",
  healthy: true,
  bid: 1.9998,
  ask: 2.0002,
  bookAt: now,
} as MarketStatus;
const quote = (buy: boolean, price: number, base = SUI): QuoteResult =>
  ({
    from: buy ? USDC : base,
    to: buy ? base : USDC,
    amountIn: buy ? String(Math.round(price * 1e6)) : "1000000000",
    amountOut: buy ? "1000000000" : String(Math.round(price * 1e6)),
    minAmountOut: "1",
  }) as QuoteResult;
it("rejects adverse buy and sell prices against the latest midpoint", () => {
  expect(quoteBookReason(quote(true, 2.01), market, 0.003, now)).toBe(
    "QUOTE_MARKET_MOVED",
  );
  expect(quoteBookReason(quote(false, 1.99), market, 0.003, now)).toBe(
    "QUOTE_MARKET_MOVED",
  );
});
it("accepts the exact boundary and better prices without counting slippage twice", () => {
  for (const [buy, price] of [
    [true, 2.006],
    [false, 1.994],
    [true, 1.99],
    [false, 2.01],
  ] as const)
    expect(quoteBookReason(quote(buy, price), market, 0.003, now)).toBeNull();
});
it("also handles WAL base units", () => {
  expect(quoteBookReason(quote(true, 2.01, WAL), market, 0.003, now)).toBe(
    "QUOTE_MARKET_MOVED",
  );
  expect(quoteBookReason(quote(false, 2, WAL), market, 0.003, now)).toBeNull();
});
it("fails closed on stale, future, unhealthy or malformed market evidence", () => {
  for (const patch of [
    { bookAt: now - 10001 },
    { bookAt: now + 5001 },
    { bookAt: null },
    { healthy: false },
  ])
    expect(
      quoteBookReason(quote(true, 2), { ...market, ...patch }, 0.003, now),
    ).toBe("STALE_ORDERBOOK");
  for (const patch of [{ bid: 0 }, { ask: NaN }, { ask: 1 }])
    expect(
      quoteBookReason(quote(true, 2), { ...market, ...patch }, 0.003, now),
    ).toBe("INVALID_ORDERBOOK");
});
it("does not apply DeepBook pricing to other sources", () => {
  expect(quoteBookReason(quote(true, 9), null, 0.003, now)).toBeNull();
  expect(
    quoteBookReason(
      quote(true, 9),
      { ...market, source: "GeckoTerminal" },
      0.003,
      now,
    ),
  ).toBeNull();
});
it("rejects invalid quote amounts and limits", () => {
  for (const amountOut of ["0", "-1", "NaN"])
    expect(
      quoteBookReason({ ...quote(true, 2), amountOut }, market, 0.003, now),
    ).toBe("INVALID_QUOTE");
  expect(quoteBookReason(quote(true, 2), market, NaN, now)).toBe(
    "INVALID_ORDERBOOK",
  );
});
