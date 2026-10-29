import {
  Decimal,
  USDC,
  coin,
  type QuoteResult,
} from "../../shared/src/index.ts";
import type { MarketStatus } from "./provider.ts";

/** Compare the quoted output, before its extra slippage reserve, with fresh book mid.
 * This is an adverse-price gate, not a forecast or a DeepBook fill simulation.
 */
export function quoteBookReason(
  q: QuoteResult,
  market: MarketStatus | null,
  limit: number,
  now: number,
): string | null {
  if (market?.source !== "DeepBook") return null;
  const { bid, ask, bookAt } = market;
  if (
    !market.healthy ||
    bookAt == null ||
    !Number.isFinite(bookAt) ||
    !Number.isFinite(now) ||
    now - bookAt > 10000 ||
    bookAt > now + 5000
  )
    return "STALE_ORDERBOOK";
  if (
    bid == null ||
    ask == null ||
    !Number.isFinite(bid) ||
    !Number.isFinite(ask) ||
    bid <= 0 ||
    ask <= bid ||
    !Number.isFinite(limit) ||
    limit < 0
  )
    return "INVALID_ORDERBOOK";
  try {
    if (
      ![q.amountIn, q.amountOut].every((x) => /^\d+$/.test(x) && BigInt(x) > 0n)
    )
      return "INVALID_QUOTE";
    const buy = coin(q.from) === USDC;
    const mid = new Decimal(bid).plus(ask).div(2);
    // Supported base assets use 9 decimals; USDC uses 6.
    const price = buy
      ? new Decimal(q.amountIn).mul(1000).div(q.amountOut)
      : new Decimal(q.amountOut).mul(1000).div(q.amountIn);
    const adverse = buy
      ? price.div(mid).minus(1)
      : new Decimal(1).minus(price.div(mid));
    return adverse.gt(limit) ? "QUOTE_MARKET_MOVED" : null;
  } catch {
    return "INVALID_QUOTE";
  }
}
