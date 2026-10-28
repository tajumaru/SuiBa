import {
  Decimal,
  SUI,
  USDC,
  coin,
  units,
  dayKey,
  type Portfolio,
  type QuoteResult,
  type Settings,
} from "../../shared/src/index.ts";
import {
  recordAcquisition,
  allocateCost,
  positionOf,
  paperCosts,
  type Costs,
} from "../../profit-guard/src/index.ts";
export interface Fill {
  orderId: string;
  side: "BUY" | "SELL";
  timestamp: number;
  quantity: number;
  price: number;
  fee: number;
  pnl: number | null;
  slippage: number;
  priceImpact: number;
  costs?: Costs;
  acquisition?: ReturnType<typeof recordAcquisition>;
  allocatedCostUsdc?: string;
  realizedProfitUsdc?: string;
}
export interface TradingExecutor {
  readonly mode: "PAPER";
  fill(
    orderId: string,
    side: "BUY" | "SELL",
    quote: QuoteResult,
    portfolio: Portfolio,
    settings: Settings,
    now: number,
  ): { portfolio: Portfolio; trade: Fill };
}
export class PaperTrading implements TradingExecutor {
  readonly mode = "PAPER" as const;
  fill(
    orderId: string,
    side: "BUY" | "SELL",
    q: QuoteResult,
    p: Portfolio,
    s: Settings,
    now: number,
  ) {
    const base = p.baseCoin ?? SUI;
    if (
      coin(side === "BUY" ? q.to : q.from) !== base ||
      coin(side === "BUY" ? q.from : q.to) !== USDC
    )
      throw Error("MARKET_PAIR_MISMATCH");
    if (now >= q.expiresAt || !q.liquid) throw new Error("UNFILLABLE_QUOTE");
    const input = units(q.amountIn, q.from),
      output = units(q.minAmountOut, q.to),
      quantity = side === "BUY" ? output : input,
      notional = side === "BUY" ? input : output,
      costs = paperCosts(q, s),
      fee = new Decimal(costs.additionalFeeUsdc!)
        .plus(costs.gasUsdc!)
        .toNumber();
    const next = { ...p, fees: p.fees + fee };
    let pnl: number | null = null;
    let acquisition: ReturnType<typeof recordAcquisition> | undefined;
    let allocatedCostUsdc: string | undefined;
    if (side === "BUY") {
      acquisition = recordAcquisition({
        ...costs,
        quantityAtomic: q.minAmountOut,
        inputUsdc: new Decimal(q.amountIn).div(1e6).toString(),
      });
      next.quantityAtomic = new Decimal(positionOf(p).quantityAtomic)
        .plus(q.minAmountOut)
        .toFixed(0);
      next.costBasisUsdc = new Decimal(positionOf(p).costUsdc)
        .plus(acquisition.totalCostUsdc)
        .toFixed(6);
      next.usdc = new Decimal(p.usdc).minus(input).minus(fee).toNumber();
      next.sui = new Decimal(next.quantityAtomic).div(1e9).toNumber();
      next.costBasis = Number(next.costBasisUsdc);
      next.dailyBought += input;
    } else {
      if (input > p.sui) throw new Error("INSUFFICIENT_BALANCE");
      const allocation = allocateCost(positionOf(p), q.amountIn);
      allocatedCostUsdc = allocation.allocatedCostUsdc;
      pnl = new Decimal(q.minAmountOut)
        .div(1e6)
        .minus(fee)
        .minus(allocatedCostUsdc)
        .toNumber();
      next.quantityAtomic = allocation.remainingQuantityAtomic;
      next.costBasisUsdc = allocation.remainingCostUsdc;
      next.usdc = new Decimal(p.usdc).plus(output).minus(fee).toNumber();
      next.sui = new Decimal(next.quantityAtomic).div(1e9).toNumber();
      next.costBasis = Number(next.costBasisUsdc);
      next.realized = new Decimal(p.realized).plus(pnl).toNumber();
    }
    if (
      next.usdc < 0 ||
      next.sui < 0 ||
      ![next.usdc, next.sui, next.costBasis].every(Number.isFinite)
    )
      throw new Error("INVALID_FILL");
    return {
      portfolio: next,
      trade: {
        orderId,
        side,
        timestamp: now,
        quantity,
        price: notional / quantity,
        fee,
        pnl,
        slippage: q.slippage,
        priceImpact: q.priceImpact,
        costs,
        acquisition,
        allocatedCostUsdc,
        realizedProfitUsdc:
          pnl === null ? undefined : new Decimal(pnl).toFixed(6),
      } satisfies Fill,
    };
  }
}
export const initialPortfolio = (now = Date.now(), usdc = 100): Portfolio => ({
  usdc,
  sui: 0,
  costBasis: 0,
  realized: 0,
  fees: 0,
  initialEquity: usdc,
  day: dayKey(now),
  dayStartEquity: usdc,
  dailyBought: 0,
});
