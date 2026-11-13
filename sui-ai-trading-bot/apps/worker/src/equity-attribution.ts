import Decimal from "decimal.js";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import type { Portfolio } from "../../../packages/shared/src/index.ts";

export type EquityAttribution =
  | { realized: number; unrealized: number }
  | { issue: "history" | "reconciliation" };

export interface ValuationPoint {
  timestamp: number;
  equity: number;
  realized?: number;
  unrealized?: number;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 0.00001;

/** Read-only replay of existing fills. Cash and acquisition cost are rebuilt
 * independently of equity, including both entry and exit fees. The current
 * portfolio is the completeness check; missing/reset histories fail closed.
 * Regular engine valuations precede the fill at the same cycle timestamp;
 * atomic valuation:<orderId> records carry realized/unrealized after the fill.
 */
export function attributeEquityHistory(
  points: readonly ValuationPoint[],
  fills: readonly Fill[],
  portfolio: Portfolio,
): (ValuationPoint & { attribution: EquityAttribution })[] {
  const unavailable = (issue: "history" | "reconciliation") =>
    points.map((p) => ({ ...p, attribution: { issue } }));
  const trades = [...fills].sort((a, b) => a.timestamp - b.timestamp);
  type State = {
    cash: Decimal;
    cost: Decimal;
    quantity: Decimal;
    realized: Decimal;
  };
  const initial = (): State => ({
    cash: new Decimal(portfolio.initialEquity),
    cost: new Decimal(0),
    quantity: new Decimal(0),
    realized: new Decimal(0),
  });
  function apply(s: State, f: Fill): State {
    if (
      ![f.timestamp, f.quantity, f.price, f.fee].every(Number.isFinite) ||
      f.quantity <= 0 ||
      f.price <= 0 ||
      f.fee < 0
    )
      throw Error("history");
    const notional = new Decimal(f.quantity).mul(f.price);
    if (f.side === "BUY") {
      const cost = new Decimal(
        f.acquisition?.totalCostUsdc ?? notional.plus(f.fee),
      );
      if (
        f.pnl !== null ||
        !near(cost.toNumber(), notional.plus(f.fee).toNumber())
      )
        throw Error("history");
      return {
        cash: s.cash.minus(notional).minus(f.fee),
        cost: s.cost.plus(cost),
        quantity: s.quantity.plus(f.quantity),
        realized: s.realized,
      };
    }
    if (f.side !== "SELL" || !Number.isFinite(f.pnl)) throw Error("history");
    // pnl is exactly the net close used by the daily review and monthly report.
    const cost = new Decimal(
      f.allocatedCostUsdc ?? notional.minus(f.fee).minus(f.pnl!),
    );
    if (!near(notional.minus(f.fee).minus(cost).toNumber(), f.pnl!))
      throw Error("history");
    const next = {
      cash: s.cash.plus(notional).minus(f.fee),
      cost: s.cost.minus(cost),
      quantity: s.quantity.minus(f.quantity),
      realized: s.realized.plus(f.pnl!),
    };
    if (next.quantity.lt(-1e-9) || next.cost.lt(-0.00001))
      throw Error("history");
    return next;
  }
  try {
    const final = trades.reduce(apply, initial());
    if (
      !near(final.cash.toNumber(), portfolio.usdc) ||
      !near(final.cost.toNumber(), portfolio.costBasis) ||
      Math.abs(final.quantity.toNumber() - portfolio.sui) > 1e-9 ||
      !near(final.realized.toNumber(), portfolio.realized)
    )
      return unavailable("history");
    let state = initial(),
      index = 0;
    return points.map((point) => {
      while (index < trades.length && trades[index].timestamp < point.timestamp)
        state = apply(state, trades[index++]);
      let valued = state;
      if (
        trades[index]?.timestamp === point.timestamp &&
        trades[index + 1]?.timestamp === point.timestamp
      ) {
        return { ...point, attribution: { issue: "history" as const } };
      }
      if (point.realized !== undefined && point.unrealized !== undefined) {
        let j = index;
        while (j < trades.length && trades[j].timestamp === point.timestamp) {
          valued = apply(valued, trades[j++]);
          if (near(valued.realized.toNumber(), point.realized)) break;
        }
        if (!near(valued.realized.toNumber(), point.realized))
          return {
            ...point,
            attribution: { issue: "reconciliation" as const },
          };
      }
      // Equity uses this very snapshot's mark. Subtract independently replayed
      // cash to obtain its marked holding value, then subtract acquisition cost.
      const unrealized = new Decimal(point.equity)
        .minus(valued.cash)
        .minus(valued.cost)
        .toNumber();
      if (
        (!valued.quantity.abs().gt(1e-9) &&
          !near(point.equity, valued.cash.toNumber())) ||
        (point.unrealized !== undefined &&
          !near(unrealized, point.unrealized)) ||
        !Number.isFinite(unrealized)
      )
        return { ...point, attribution: { issue: "reconciliation" as const } };
      return {
        ...point,
        attribution: { realized: valued.realized.toNumber(), unrealized },
      };
    });
  } catch {
    return unavailable("history");
  }
}
