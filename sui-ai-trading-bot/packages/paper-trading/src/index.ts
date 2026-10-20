import {
  Decimal,
  units,
  dayKey,
  type Portfolio,
  type QuoteResult,
  type Settings,
} from "../../shared/src/index.ts";
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
}
import type { TradingExecutor as ExecutorContract } from "../../shared/src/execution.ts";
export type PaperRequest = {
  orderId: string;
  side: "BUY" | "SELL";
  quote: QuoteResult;
  portfolio: Portfolio;
  settings: Settings;
  now: number;
};
export interface TradingExecutor extends ExecutorContract<
  "PAPER",
  PaperRequest,
  { portfolio: Portfolio; trade: Fill }
> {
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
  async prepare(r: PaperRequest) {
    return this.fill(
      r.orderId,
      r.side,
      r.quote,
      r.portfolio,
      r.settings,
      r.now,
    );
  }
  fill(
    orderId: string,
    side: "BUY" | "SELL",
    q: QuoteResult,
    p: Portfolio,
    s: Settings,
    now: number,
  ) {
    if (now >= q.expiresAt || !q.liquid) throw new Error("UNFILLABLE_QUOTE");
    const input = units(q.amountIn, q.from),
      output = units(q.minAmountOut, q.to),
      quantity = side === "BUY" ? output : input,
      notional = side === "BUY" ? input : output,
      fee = notional * s.feeRate + s.gasUsdc;
    const next = { ...p, fees: p.fees + fee };
    let pnl: number | null = null;
    if (side === "BUY") {
      next.usdc = new Decimal(p.usdc).minus(input).minus(fee).toNumber();
      next.sui = new Decimal(p.sui).plus(output).toNumber();
      next.costBasis = p.costBasis + input + fee;
      next.dailyBought += input;
    } else {
      if (input > p.sui) throw new Error("INSUFFICIENT_BALANCE");
      const basis = p.sui ? (p.costBasis * input) / p.sui : 0;
      pnl = output - fee - basis;
      next.usdc = new Decimal(p.usdc).plus(output).minus(fee).toNumber();
      next.sui = Math.max(0, new Decimal(p.sui).minus(input).toNumber());
      next.costBasis = Math.max(0, p.costBasis - basis);
      next.realized += pnl;
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
