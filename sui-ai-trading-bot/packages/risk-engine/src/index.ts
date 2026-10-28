import {
  coin,
  SUI,
  USDC,
  units,
  settingsSchema,
  type Portfolio,
  type Runtime,
  type Settings,
  type QuoteResult,
} from "../../shared/src/index.ts";
import { equity } from "../../portfolio/src/index.ts";
export interface RiskInput {
  side: "BUY" | "SELL";
  quote: QuoteResult;
  portfolio: Portfolio;
  runtime: Runtime;
  settings: Settings;
  price: number;
  marketClosedAt: number;
  now: number;
  duplicate: boolean;
  pending: number;
}
export function assessRisk(x: RiskInput): string[] {
  const reasons: string[] = [];
  const { quote: q, portfolio: p, settings: s } = x;
  if (
    !settingsSchema.safeParse(s).success ||
    ![
      p.usdc,
      p.sui,
      p.costBasis,
      p.realized,
      p.fees,
      p.initialEquity,
      p.dayStartEquity,
      p.dailyBought,
      q.createdAt,
      q.expiresAt,
      x.pending,
    ].every(Number.isFinite) ||
    p.usdc < 0 ||
    p.sui < 0 ||
    p.costBasis < 0 ||
    p.dayStartEquity <= 0 ||
    p.dailyBought < 0 ||
    ![q.amountIn, q.amountOut, q.minAmountOut].every((v) => /^\d+$/.test(v))
  ) {
    return ["INVALID_STATE_OR_QUOTE"];
  }
  if (BigInt(q.minAmountOut) > BigInt(q.amountOut) || BigInt(q.amountIn) <= 0n)
    return ["INVALID_AMOUNT"];
  if (!x.runtime.running || x.runtime.emergency || x.runtime.error)
    reasons.push("BOT_STOPPED");
  try {
    if (
      coin(q.from) !== (x.side === "BUY" ? USDC : (p.baseCoin ?? SUI)) ||
      coin(q.to) !== (x.side === "BUY" ? (p.baseCoin ?? SUI) : USDC)
    )
      reasons.push("COIN_DIRECTION");
  } catch {
    reasons.push("COIN_NOT_ALLOWED");
    return reasons;
  }
  const input = units(q.amountIn, q.from),
    output = units(q.minAmountOut, q.to),
    notional = x.side === "BUY" ? input : input * x.price,
    e = equity(p, x.price);
  const costs = notional * s.feeRate + s.gasUsdc;
  if (
    ![
      input,
      output,
      notional,
      e,
      x.price,
      q.priceImpact,
      q.slippage,
      x.now,
      x.marketClosedAt,
    ].every(Number.isFinite) ||
    input <= 0 ||
    output <= 0 ||
    x.price <= 0 ||
    e <= 0
  )
    reasons.push("INVALID_NUMBERS");
  if (notional > s.maxOrder + 1e-9) reasons.push("MAX_ORDER");
  if (
    (x.side === "BUY" && p.usdc < input + costs) ||
    (x.side === "SELL" && (p.sui < input || p.usdc + output < costs))
  )
    reasons.push("INSUFFICIENT_BALANCE");
  if (x.side === "BUY") {
    if (p.dailyBought + notional > s.dailyBuyLimit)
      reasons.push("DAILY_BUY_LIMIT");
    if (e <= p.dayStartEquity * (1 - s.dailyLossPct))
      reasons.push("DAILY_LOSS_LIMIT");
    if (
      ((p.sui + units(q.amountOut, q.to)) * x.price) / (e - costs) >
      s.maxHoldingRatio
    )
      reasons.push("MAX_HOLDING");
  }
  if (
    q.slippage < 0 ||
    q.slippage > s.maxSlippage ||
    q.priceImpact < 0 ||
    q.priceImpact > s.maxSlippage
  )
    reasons.push("SLIPPAGE_OR_IMPACT");
  if (!q.liquid || !q.route.length) reasons.push("NO_LIQUIDITY");
  if (
    q.createdAt > x.now ||
    q.expiresAt <= x.now ||
    q.expiresAt - q.createdAt > 15000
  )
    reasons.push("QUOTE_EXPIRED");
  if (x.marketClosedAt > x.now || x.now - x.marketClosedAt > 360000)
    reasons.push("STALE_MARKET");
  if (x.duplicate) reasons.push("DUPLICATE_ORDER");
  if (x.pending >= 1) reasons.push("CONCURRENT_ORDER");
  return reasons;
}
