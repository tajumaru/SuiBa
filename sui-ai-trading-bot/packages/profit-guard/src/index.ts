import {
  Decimal,
  coin,
  SUI,
  USDC,
  atomic,
  profitDefaults,
  profitConfigSchema,
  type ProfitConfig,
  type QuoteResult,
  type Portfolio,
} from "../../shared/src/index.ts";
export { profitDefaults };
// Private Decimal constructor: never change rounding/precision for indicators, SDKs or other packages.
const D = Decimal.clone({ precision: 60 });
export interface Costs {
  additionalFeeUsdc: string | null;
  gasUsdc: string | null;
  dexFeeUsdc: string | null;
  source: "PAPER_MODEL" | "LIVE_ACTUAL";
}
export interface Position {
  quantityAtomic: string;
  costUsdc: string;
}
export type Purpose =
  | "TAKE_PROFIT"
  | "STOP_LOSS"
  | "STRATEGY_EXIT"
  | "RISK_REDUCTION"
  | "EMERGENCY_EXIT";
export interface ProfitReport {
  allowed: boolean;
  action: "BUY" | "SELL" | "WAIT";
  reason: string;
  scope: "BUY_SCENARIO" | "SELL_QUOTE";
  purpose: Purpose | null;
  asOf: number;
  validUntil: number | null;
  quantityAtomic: string | null;
  allocatedCostUsdc: string | null;
  purchaseInputUsdc: string | null;
  acquisitionUnitPrice: string | null;
  netProfitUsdc: string | null;
  netProfitPct: string | null;
  breakEvenPrice: string | null;
  roundTripCostUsdc: string | null;
  targetPrice: string | null;
  targetProfitPct: string;
  costs: Costs | null;
  buyCosts: Costs | null;
  minProfitUsdc: string;
  minProfitPct: string;
  quoteId: string | null;
  source: string | null;
}
const decimal = (v: string) => {
  const x = new D(v);
  if (!x.isFinite() || x.lt(0)) throw new Error("INVALID_COST");
  return x;
};
const qty = (v: string) => {
  if (typeof v !== "string" || !/^\d+$/.test(v) || BigInt(v) <= 0n)
    throw new Error("INVALID_QUANTITY");
  return new D(v);
};
export const expense = (v: string) =>
  decimal(v).toDecimalPlaces(6, D.ROUND_CEIL).toFixed(6);
const income = (v: Decimal.Value) => new D(v).toDecimalPlaces(6, D.ROUND_FLOOR);
function knownCosts(c: Costs) {
  if (c.gasUsdc === null || c.additionalFeeUsdc === null)
    throw new Error("UNKNOWN_COSTS");
  return {
    ...c,
    gasUsdc: expense(c.gasUsdc),
    additionalFeeUsdc: expense(c.additionalFeeUsdc),
    dexFeeUsdc: c.dexFeeUsdc === null ? null : expense(c.dexFeeUsdc),
  };
}
export function recordAcquisition(
  r: Costs & { quantityAtomic: string; inputUsdc: string },
) {
  qty(r.quantityAtomic);
  const c = knownCosts(r);
  return {
    ...c,
    quantityAtomic: r.quantityAtomic,
    inputUsdc: expense(r.inputUsdc),
    totalCostUsdc: decimal(r.inputUsdc)
      .plus(c.additionalFeeUsdc!)
      .plus(c.gasUsdc!)
      .toDecimalPlaces(6, D.ROUND_CEIL)
      .toFixed(6),
  };
}
export function positionOf(p: Portfolio): Position {
  return {
    quantityAtomic: p.quantityAtomic ?? atomic(p.sui, SUI),
    costUsdc: p.costBasisUsdc ?? String(p.costBasis),
  };
}
export function allocateCost(p: Position, sold: string) {
  const total = qty(p.quantityAtomic),
    amount = qty(sold);
  if (amount.gt(total)) throw new Error("OVERSELL");
  const cost = decimal(expense(p.costUsdc));
  const allocated = amount.eq(total)
    ? cost
    : cost.mul(amount).div(total).toDecimalPlaces(6, D.ROUND_CEIL);
  return {
    allocatedCostUsdc: allocated.toFixed(6),
    remainingCostUsdc: cost.minus(allocated).toFixed(6),
    remainingQuantityAtomic: total.minus(amount).toFixed(0),
  };
}
export function paperCosts(
  q: QuoteResult,
  s: { feeRate: number; gasUsdc: number },
): Costs {
  const usdc =
    coin(q.from) === USDC
      ? new D(q.amountIn).div(1e6)
      : new D(q.minAmountOut).div(1e6);
  return {
    additionalFeeUsdc: expense(usdc.mul(s.feeRate).toString()),
    gasUsdc: Number.isFinite(s.gasUsdc) ? expense(String(s.gasUsdc)) : null,
    dexFeeUsdc: q.dexFeeUsdc ?? null,
    source: "PAPER_MODEL",
  };
}
function report(
  config: ProfitConfig,
  now: number,
  scope: ProfitReport["scope"],
): ProfitReport {
  return {
    allowed: false,
    action: "WAIT",
    reason: "PROFIT_DATA_UNKNOWN",
    scope,
    purpose: null,
    asOf: now,
    validUntil: null,
    quantityAtomic: null,
    allocatedCostUsdc: null,
    purchaseInputUsdc: null,
    acquisitionUnitPrice: null,
    netProfitUsdc: null,
    netProfitPct: null,
    breakEvenPrice: null,
    roundTripCostUsdc: null,
    targetPrice: null,
    targetProfitPct: config.targetProfitPct,
    costs: null,
    buyCosts: null,
    minProfitUsdc: config.minProfitUsdc,
    minProfitPct: config.minProfitPct,
    quoteId: null,
    source: null,
  };
}
function validQuote(
  q: QuoteResult | null,
  now: number,
  from: string,
  to: string,
): asserts q is QuoteResult {
  if (!q) throw new Error("QUOTE_UNAVAILABLE");
  if (
    coin(q.from) !== from ||
    coin(q.to) !== to ||
    !Number.isFinite(now) ||
    !Number.isFinite(q.createdAt) ||
    !Number.isFinite(q.expiresAt) ||
    q.createdAt > now ||
    q.expiresAt <= q.createdAt ||
    q.expiresAt - q.createdAt > 15000 ||
    !q.liquid ||
    !Array.isArray(q.route) ||
    !q.route.length ||
    !Number.isFinite(q.referencePrice) ||
    q.referencePrice <= 0
  )
    throw new Error("INVALID_QUOTE");
  if (q.expiresAt <= now) throw new Error("QUOTE_EXPIRED");
  qty(q.amountIn);
  qty(q.amountOut);
  qty(q.minAmountOut);
  if (new D(q.minAmountOut).gt(q.amountOut)) throw new Error("INVALID_MINIMUM");
}
function passes(
  net: InstanceType<typeof D>,
  basis: InstanceType<typeof D>,
  c: ProfitConfig,
) {
  return (
    basis.gt(0) &&
    net.gte(expense(c.minProfitUsdc)) &&
    net.div(basis).gte(c.minProfitPct)
  );
}
// Break-even is a quote-based model: both embedded route costs and slippage are already in gross.
function breakEven(
  gross: InstanceType<typeof D>,
  fees: InstanceType<typeof D>,
  gas: InstanceType<typeof D>,
  basis: InstanceType<typeof D>,
  price: number,
) {
  return gross.gt(fees)
    ? new D(price)
        .mul(basis.plus(gas))
        .div(gross.minus(fees))
        .toDecimalPlaces(12, D.ROUND_CEIL)
        .toFixed(12)
    : null;
}
export function evaluateSell(r: {
  position: Position;
  quote: QuoteResult | null;
  costs: Costs;
  purpose: Purpose;
  config: ProfitConfig;
  now: number;
}): ProfitReport {
  const out = report(r.config ?? profitDefaults, r.now, "SELL_QUOTE");
  out.purpose = r.purpose;
  const bypass = [
    "STOP_LOSS",
    "STRATEGY_EXIT",
    "EMERGENCY_EXIT",
    "RISK_REDUCTION",
  ].includes(r.purpose);
  let failure = "INVALID_PROFIT_CONFIG";
  try {
    profitConfigSchema.parse(r.config);
    failure = "INVALID_QUOTE";
    validQuote(r.quote, r.now, SUI, USDC);
    const q = r.quote;
    failure = "UNKNOWN_COSTS";
    const c = knownCosts(r.costs);
    failure = "INVALID_POSITION";
    const holding = qty(r.position.quantityAtomic);
    decimal(r.position.costUsdc);
    if (new D(q.amountIn).gt(holding)) {
      failure = "INSUFFICIENT_POSITION";
      throw new Error("INSUFFICIENT_POSITION");
    }
    const allocation = allocateCost(r.position, q.amountIn),
      basis = new D(allocation.allocatedCostUsdc),
      gross = new D(q.minAmountOut).div(1e6),
      fee = new D(c.additionalFeeUsdc!),
      gas = new D(c.gasUsdc!),
      net = income(gross.minus(fee).minus(gas).minus(basis));
    Object.assign(out, {
      quantityAtomic: q.amountIn,
      allocatedCostUsdc: basis.toFixed(6),
      costs: c,
      netProfitUsdc: net.toFixed(6),
      netProfitPct: basis.gt(0)
        ? net.div(basis).toDecimalPlaces(12, D.ROUND_FLOOR).toFixed(12)
        : null,
      breakEvenPrice: breakEven(gross, fee, gas, basis, q.referencePrice),
      quoteId: q.id,
      source: q.source,
      validUntil: q.expiresAt,
    });
    out.allowed =
      bypass || r.config.enabled === false || passes(net, basis, r.config);
    out.reason =
      r.config.enabled === false
        ? "PROFIT_GUARD_DISABLED"
        : bypass
          ? "PROTECTIVE_EXIT_PROFIT_BYPASS"
          : out.allowed
            ? "MINIMUM_NET_PROFIT_MET"
            : "MINIMUM_NET_PROFIT_NOT_MET";
  } catch (error) {
    // Only emit fixed reason codes, never external exception messages or payloads.
    out.reason =
      failure === "INVALID_QUOTE" &&
      error instanceof Error &&
      ["QUOTE_UNAVAILABLE", "QUOTE_EXPIRED"].includes(error.message)
        ? error.message
        : failure;
    out.allowed = false;
  }
  out.action = out.allowed ? "SELL" : "WAIT";
  return out;
}
export function strategyExitPrice(
  position: Position,
  buy: QuoteResult,
  costs: Costs,
  takeProfitPct: number,
) {
  if (!Number.isFinite(takeProfitPct) || takeProfitPct <= 0)
    throw new Error("UNKNOWN_TARGET");
  const acquisition = recordAcquisition({
    ...costs,
    quantityAtomic: buy.minAmountOut,
    inputUsdc: new D(buy.amountIn).div(1e6).toString(),
  });
  const totalQty = decimal(position.quantityAtomic)
    .plus(qty(buy.minAmountOut))
    .div(1e9);
  return decimal(position.costUsdc)
    .plus(acquisition.totalCostUsdc)
    .div(totalQty)
    .mul(new D(1).plus(takeProfitPct))
    .toDecimalPlaces(12, D.ROUND_FLOOR)
    .toFixed(12);
}
export function evaluateBuy(r: {
  buyQuote: QuoteResult | null;
  sellQuote: QuoteResult | null;
  buyCosts: Costs;
  sellCosts: Costs;
  config: ProfitConfig;
  now: number;
  maxExitUsdc?: string;
  strategyTargetPrice?: string;
}): ProfitReport {
  const out = report(r.config, r.now, "BUY_SCENARIO");
  try {
    profitConfigSchema.parse(r.config);
    validQuote(r.buyQuote, r.now, USDC, SUI);
    validQuote(r.sellQuote, r.now, SUI, USDC);
    const b = r.buyQuote,
      s = r.sellQuote;
    if (s.amountIn !== b.minAmountOut || s.referencePrice !== b.referencePrice)
      throw new Error("REVERSE_QUOTE_MISMATCH");
    const buy = recordAcquisition({
        ...r.buyCosts,
        quantityAtomic: b.minAmountOut,
        inputUsdc: new D(b.amountIn).div(1e6).toString(),
      }),
      exit = knownCosts(r.sellCosts),
      basis = new D(buy.totalCostUsdc),
      gross = new D(s.minAmountOut).div(1e6),
      fee = new D(exit.additionalFeeUsdc!),
      gas = new D(exit.gasUsdc!),
      roundTrip = D.max(0, basis.minus(gross.minus(fee).minus(gas))),
      configuredPrice = new D(b.referencePrice).mul(
        new D(1).plus(r.config.targetProfitPct),
      ),
      targetPrice =
        r.strategyTargetPrice === undefined
          ? configuredPrice
          : D.min(configuredPrice, decimal(r.strategyTargetPrice)),
      factor = targetPrice.div(b.referencePrice),
      futureGross = income(gross.mul(factor)),
      limit = decimal(r.maxExitUsdc ?? "5");
    if (limit.lte(0)) throw new Error("INVALID_EXIT_LIMIT");
    const chunks = D.max(
      1,
      new D(b.minAmountOut).div(1e9).mul(targetPrice).div(limit).ceil(),
    );
    const futureFee = fee
      .mul(factor)
      .div(chunks)
      .toDecimalPlaces(6, D.ROUND_CEIL)
      .mul(chunks);
    const net = income(
      futureGross.minus(futureFee).minus(gas.mul(chunks)).minus(basis),
    );
    Object.assign(out, {
      quantityAtomic: b.minAmountOut,
      allocatedCostUsdc: buy.totalCostUsdc,
      purchaseInputUsdc: buy.inputUsdc,
      acquisitionUnitPrice: basis
        .div(new D(b.minAmountOut).div(1e9))
        .toDecimalPlaces(12, D.ROUND_CEIL)
        .toFixed(12),
      buyCosts: knownCosts(r.buyCosts),
      costs: exit,
      roundTripCostUsdc: roundTrip.toDecimalPlaces(6, D.ROUND_CEIL).toFixed(6),
      netProfitUsdc: net.toFixed(6),
      netProfitPct: net
        .div(basis)
        .toDecimalPlaces(12, D.ROUND_FLOOR)
        .toFixed(12),
      targetPrice: targetPrice.toFixed(12),
      breakEvenPrice: breakEven(
        gross,
        fee,
        gas.mul(chunks),
        basis,
        b.referencePrice,
      ),
      quoteId: s.id,
      source: s.source,
      validUntil: Math.min(b.expiresAt, s.expiresAt),
    });
    out.allowed =
      r.config.enabled === false ||
      (net.gt(roundTrip) && passes(net, basis, r.config));
    out.reason =
      r.config.enabled === false
        ? "PROFIT_GUARD_DISABLED"
        : out.allowed
          ? "PROJECTED_NET_EXCEEDS_ROUND_TRIP_COST"
          : "PROJECTED_NET_INSUFFICIENT";
  } catch {
    out.reason =
      !r.buyQuote || !r.sellQuote ? "QUOTE_UNAVAILABLE" : "PROFIT_DATA_UNKNOWN";
  }
  out.action = out.allowed ? "BUY" : "WAIT";
  return out;
}
