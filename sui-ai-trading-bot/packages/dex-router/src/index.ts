import { sdkRequests } from "../../shared/src/sdk-requests.ts";
import { AggregatorClient } from "@cetusprotocol/aggregator-sdk";
import { randomUUID } from "node:crypto";
import {
  Decimal,
  coin,
  units,
  USDC,
  type DexRouter,
  type QuoteRequest,
  type QuoteResult,
} from "../../shared/src/index.ts";
export class CetusRouter implements DexRouter {
  private client = new AggregatorClient({});
  async getQuote(r: QuoteRequest): Promise<QuoteResult> {
    const from = coin(r.from),
      to = coin(r.to);
    if (
      from === to ||
      !/^\d+$/.test(r.amountIn) ||
      BigInt(r.amountIn) <= 0n ||
      !Number.isFinite(r.referencePrice) ||
      r.referencePrice <= 0 ||
      !Number.isFinite(r.slippage) ||
      r.slippage < 0 ||
      r.slippage > 0.003
    )
      throw new Error("INVALID_QUOTE_REQUEST");
    const started = Date.now();
    const q = await sdkRequests(() =>
      this.client.findRouters({
        from,
        target: to,
        amount: r.amountIn,
        byAmountIn: true,
        slippage: r.slippage,
      }),
    );
    if (
      !q ||
      q.error ||
      q.insufficientLiquidity ||
      !q.paths.length ||
      q.amountIn.toString() !== r.amountIn ||
      q.amountOut.lten(0) ||
      (q.totalDeepFee ?? 0) > 0
    )
      throw new Error("NO_LIQUID_ROUTE_OR_UNMODELED_FEE");
    // Output already incorporates route fees and pool impact; compare against historical reference separately.
    const input = units(r.amountIn, from),
      output = units(q.amountOut.toString(), to);
    const expected =
      from !== USDC ? input * r.referencePrice : input / r.referencePrice;
    const impact = Math.max(
      0,
      Math.abs(1 - output / expected),
      Math.abs(q.deviationRatio),
    );
    if (!Number.isFinite(impact)) throw new Error("UNKNOWN_PRICE_IMPACT");
    return {
      ...r,
      from,
      to,
      id: q.quoteID ?? randomUUID(),
      amountOut: q.amountOut.toString(),
      minAmountOut: new Decimal(q.amountOut.toString())
        .mul(1 - r.slippage)
        .floor()
        .toFixed(0),
      priceImpact: impact,
      liquid: true,
      createdAt: started,
      expiresAt: started + 15000,
      route: q.paths.map((p) => p.provider),
      source: "Cetus Aggregator V3",
      // Embedded route fees cannot be separated into exact USDC by this SDK response.
      dexFeeUsdc: null,
    };
  }
  async validateQuote(q: QuoteResult) {
    try {
      return (
        coin(q.from) !== coin(q.to) &&
        q.liquid &&
        Number.isFinite(q.priceImpact) &&
        q.priceImpact >= 0 &&
        q.priceImpact <= 0.003 &&
        q.createdAt <= Date.now() &&
        Date.now() < q.expiresAt &&
        q.expiresAt - q.createdAt <= 15000 &&
        BigInt(q.amountOut) > 0n &&
        BigInt(q.minAmountOut) > 0n &&
        BigInt(q.minAmountOut) <= BigInt(q.amountOut)
      );
    } catch {
      return false;
    }
  }
}
