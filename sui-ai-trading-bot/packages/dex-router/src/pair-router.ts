import {
  Decimal,
  WAL,
  USDC,
  coin,
  type DexRouter,
  type QuoteRequest,
  type QuoteResult,
} from "../../shared/src/index.ts";
import type { DeepBookMarketData } from "../../market-data/src/deepbook.ts";
/** WAL market-order sizing. No signing or transaction submission. */
export class WalPaperRouter implements DexRouter {
  constructor(
    private inner: DexRouter,
    private market: DeepBookMarketData,
  ) {}
  async getQuote(request: QuoteRequest): Promise<QuoteResult> {
    this.market.assertReady(Date.now());
    const params = this.market.bookParams;
    if (!params) throw Error("MARKET_PAIR_MISMATCH");
    const buy = coin(request.from) === USDC;
    if (
      coin(buy ? request.to : request.from) !== WAL ||
      coin(buy ? request.from : request.to) !== USDC
    )
      throw Error("MARKET_PAIR_MISMATCH");
    const lot = new Decimal(params.lotSize);
    const floorLot = (v: string) =>
      new Decimal(v).div(lot).floor().mul(lot).toFixed(0);
    const r = buy
      ? request
      : { ...request, amountIn: floorLot(request.amountIn) };
    if (!buy && new Decimal(r.amountIn).lt(params.minSize))
      throw Error("MIN_ORDER_SIZE");
    const q = await this.inner.getQuote(r);
    const result = buy ? { ...q, minAmountOut: floorLot(q.minAmountOut) } : q;
    if (buy)
      result.priceImpact = new Decimal(q.priceImpact)
        .plus(
          new Decimal(q.minAmountOut)
            .minus(result.minAmountOut)
            .div(q.minAmountOut),
        )
        .toNumber();
    if (
      new Decimal(buy ? result.minAmountOut : result.amountIn).lt(
        params.minSize,
      )
    )
      throw Error("MIN_ORDER_SIZE");
    return result;
  }
  async validateQuote(q: QuoteResult) {
    const params = this.market.bookParams;
    if (!params) return false;
    try {
      this.market.assertReady(Date.now());
      const buy = coin(q.from) === USDC;
      if (
        coin(buy ? q.to : q.from) !== WAL ||
        coin(buy ? q.from : q.to) !== USDC
      )
        return false;
      const quantity = new Decimal(buy ? q.minAmountOut : q.amountIn);
      return (
        quantity.gte(params.minSize) &&
        quantity.mod(params.lotSize).isZero() &&
        (await this.inner.validateQuote(q))
      );
    } catch {
      return false;
    }
  }
}
