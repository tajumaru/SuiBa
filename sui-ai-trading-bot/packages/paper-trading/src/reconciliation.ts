import {
  Decimal,
  type Portfolio,
  type QuoteResult,
} from "../../shared/src/index.ts";
import type { Fill } from "./index.ts";
const D = Decimal.clone({ precision: 60 });
export const accountingTolerance = {
  sui: "0.000000001",
  usdc: "0.000001",
} as const;
export interface AccountingCheck {
  timestamp: number;
  orderId: string;
  ok: boolean;
  reasons: string[];
  tolerance: { sui: string; usdc: string; equityUsdc: string };
  expected: Record<string, string | null>;
  actual: Record<string, string | null>;
}
// Independent transition equations; do not call the executor or cost-allocation helpers.
export function reconcileFill(
  before: Portfolio,
  after: Portfolio,
  trade: Fill,
  q: QuoteResult,
  mark: number,
): AccountingCheck {
  const reasons: string[] = [],
    expected: AccountingCheck["expected"] = {},
    actual: AccountingCheck["actual"] = {};
  const equityTolerance = new D(accountingTolerance.usdc).plus(
    new D(Number.isFinite(mark) ? Math.abs(mark) : 0).mul(
      accountingTolerance.sui,
    ),
  );
  const result: AccountingCheck = {
    timestamp: trade.timestamp,
    orderId: trade.orderId,
    ok: false,
    reasons,
    tolerance: {
      ...accountingTolerance,
      equityUsdc: equityTolerance.toString(),
    },
    expected,
    actual,
  };
  const compare = (
    key: string,
    want: Decimal.Value,
    got: Decimal.Value,
    tolerance: Decimal.Value = accountingTolerance.usdc,
  ) => {
    const a = new D(want),
      b = new D(got);
    expected[key] = a.toString();
    actual[key] = b.toString();
    if (!a.isFinite() || !b.isFinite() || a.minus(b).abs().gt(tolerance))
      reasons.push(`MISMATCH_${key.toUpperCase()}`);
  };
  try {
    if (!Number.isFinite(mark) || mark <= 0) throw new Error("INVALID_MARK");
    const gas = trade.costs?.gasUsdc,
      additional = trade.costs?.additionalFeeUsdc;
    if (gas == null || additional == null) throw new Error("UNKNOWN_COSTS");
    const fee = new D(gas).plus(additional);
    if (!fee.isFinite() || new D(gas).lt(0) || new D(additional).lt(0))
      throw new Error("UNKNOWN_COSTS");
    const quantity = new D(
      trade.side === "BUY" ? q.minAmountOut : q.amountIn,
    ).div(1e9);
    const cash = new D(trade.side === "BUY" ? q.amountIn : q.minAmountOut).div(
      1e6,
    );
    const oldQty = new D(
      before.quantityAtomic ?? new D(before.sui).mul(1e9).floor(),
    );
    const oldBasis = new D(before.costBasisUsdc ?? before.costBasis);
    if (
      !oldBasis.isFinite() ||
      oldBasis.lt(0) ||
      !oldQty.isFinite() ||
      oldQty.lt(0)
    )
      throw new Error("UNKNOWN_COST_BASIS");
    const signed = trade.side === "BUY" ? 1 : -1;
    const nextQty = oldQty.plus(quantity.mul(1e9).mul(signed));
    if (nextQty.lt(0) || quantity.lte(0) || cash.lte(0))
      throw new Error("INVALID_QUANTITY");
    let basis: Decimal,
      realized = new D(before.realized);
    if (trade.side === "BUY") {
      const acquired = cash.plus(fee).toDecimalPlaces(6, D.ROUND_CEIL);
      basis = oldBasis.plus(acquired).toDecimalPlaces(6, D.ROUND_HALF_UP);
      if (!trade.acquisition) throw new Error("UNKNOWN_COST_BASIS");
      compare("acquisitionCost", acquired, trade.acquisition.totalCostUsdc);
    } else {
      if (oldQty.lte(0)) throw new Error("UNKNOWN_COST_BASIS");
      const roundedBasis = oldBasis.toDecimalPlaces(6, D.ROUND_CEIL);
      const allocated = quantity.mul(1e9).eq(oldQty)
        ? roundedBasis
        : roundedBasis
            .mul(quantity.mul(1e9))
            .div(oldQty)
            .toDecimalPlaces(6, D.ROUND_CEIL);
      basis = roundedBasis.minus(allocated);
      const profit = cash.minus(fee).minus(allocated);
      realized = realized.plus(profit);
      if (trade.allocatedCostUsdc == null || trade.pnl == null)
        throw new Error("UNKNOWN_COST_BASIS");
      compare("allocatedCost", allocated, trade.allocatedCostUsdc);
      compare("tradeRealized", profit, trade.pnl);
    }
    const usdc = new D(before.usdc).plus(cash.mul(-signed)).minus(fee);
    const sui = nextQty.div(1e9),
      unrealized = sui.mul(mark).minus(basis),
      equity = usdc.plus(sui.mul(mark));
    compare("usdc", usdc, after.usdc);
    compare("sui", sui, after.sui, accountingTolerance.sui);
    compare(
      "quantityAtomic",
      nextQty,
      after.quantityAtomic ?? new D(after.sui).mul(1e9),
      0,
    );
    compare("costBasis", basis, after.costBasis);
    compare("costBasisUsdc", basis, after.costBasisUsdc ?? after.costBasis);
    compare("realized", realized, after.realized);
    compare(
      "unrealized",
      unrealized,
      new D(after.sui).mul(mark).minus(after.costBasis),
      equityTolerance,
    );
    compare("fees", new D(before.fees).plus(fee), after.fees);
    compare("tradeFee", fee, trade.fee);
    compare("quantity", quantity, trade.quantity, accountingTolerance.sui);
    compare(
      "equity",
      equity,
      new D(after.usdc).plus(new D(after.sui).mul(mark)),
      equityTolerance,
    );
    // Compare the P&L movement, so pre-monitor legacy positions do not invent an opening cash balance.
    compare(
      "pnlMovement",
      equity.minus(new D(before.usdc).plus(new D(before.sui).mul(mark))),
      realized
        .minus(before.realized)
        .plus(
          unrealized.minus(new D(before.sui).mul(mark).minus(before.costBasis)),
        ),
      equityTolerance,
    );
    expected.gasUsdc = new D(gas).toString();
    actual.gasUsdc = new D(gas).toString();
    if (
      [after.usdc, after.sui, after.costBasis, after.fees].some(
        (v) => !Number.isFinite(v) || v < 0,
      )
    )
      reasons.push("INVALID_BALANCE");
  } catch (error) {
    reasons.push(
      error instanceof Error &&
        [
          "UNKNOWN_COSTS",
          "UNKNOWN_COST_BASIS",
          "INVALID_MARK",
          "INVALID_QUANTITY",
        ].includes(error.message)
        ? error.message
        : "INVALID_ACCOUNTING_DATA",
    );
  }
  result.ok = reasons.length === 0;
  return result;
}
