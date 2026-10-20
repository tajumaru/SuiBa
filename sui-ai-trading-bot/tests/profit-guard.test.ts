import { describe, it, expect } from "vitest";
import {
  recordAcquisition,
  allocateCost,
  evaluateSell,
  evaluateBuy,
  paperCosts,
  profitDefaults,
} from "../packages/profit-guard/src/index.ts";
import { SUI, USDC, type QuoteResult } from "../packages/shared/src/index.ts";
import { defaults } from "../packages/shared/src/index.ts";
import {
  PaperTrading,
  initialPortfolio,
} from "../packages/paper-trading/src/index.ts";
const now = 1800000000000;
function sell(min = "5200000"): QuoteResult {
  return {
    id: "mock",
    from: SUI,
    to: USDC,
    amountIn: "2500000000",
    amountOut: min,
    minAmountOut: min,
    slippage: 0,
    referencePrice: 2,
    priceImpact: 0,
    liquid: true,
    createdAt: now,
    expiresAt: now + 15000,
    route: ["CETUS"],
    source: "mock",
  };
}
const position = { quantityAtomic: "2500000000", costUsdc: "5.045000" };
const costs = {
  additionalFeeUsdc: "0.015600",
  gasUsdc: "0.030000",
  dexFeeUsdc: null,
  source: "PAPER_MODEL" as const,
};
describe("ProfitGuard contract (test-first)", () => {
  it("records PAPER acquisition costs and reconciles two partial exits with the exact remaining basis", () => {
    const paper = new PaperTrading(),
      q = {
        ...sell("2500000000"),
        from: USDC,
        to: SUI,
        amountIn: "5000000",
        amountOut: "2500000000",
        minAmountOut: "2500000000",
      };
    const buy = paper.fill("b", "BUY", q, initialPortfolio(now), defaults, now);
    expect(buy.trade.acquisition?.totalCostUsdc).toBe("5.045000");
    expect(buy.trade.costs?.dexFeeUsdc).toBeNull();
    const a = paper.fill(
      "s1",
      "SELL",
      { ...sell("2100000"), amountIn: "1000000000" },
      buy.portfolio,
      defaults,
      now,
    );
    const b = paper.fill(
      "s2",
      "SELL",
      { ...sell("3150000"), amountIn: "1500000000" },
      a.portfolio,
      defaults,
      now,
    );
    expect(a.trade.allocatedCostUsdc).toBe("2.018000");
    expect(b.trade.allocatedCostUsdc).toBe("3.027000");
    expect(b.portfolio.costBasisUsdc).toBe("0.000000");
    expect(b.portfolio.quantityAtomic).toBe("0");
    expect(b.portfolio.usdc - 100).toBeCloseTo(b.portfolio.realized, 10);
  });
  it("does not treat an unknown SELL purpose as a protective-exit permission", () => {
    expect(
      evaluateSell({
        position,
        quote: sell("4000000"),
        costs,
        purpose: "UNRECOGNIZED" as never,
        config: profitDefaults,
        now,
      }).allowed,
    ).toBe(false);
  });
  it("records acquired quantity and all-in cost without double-counting embedded DEX fees", () => {
    const r = recordAcquisition({
      quantityAtomic: position.quantityAtomic,
      inputUsdc: "5",
      additionalFeeUsdc: "0.015",
      gasUsdc: "0.03",
      dexFeeUsdc: "0.01",
      source: "PAPER_MODEL",
    });
    expect(r.totalCostUsdc).toBe("5.045000");
    expect(r.dexFeeUsdc).toBe("0.010000");
    expect(r.quantityAtomic).toBe(position.quantityAtomic);
  });
  it("uses actual minimum output and deducts basis, exit fee and gas exactly once", () => {
    const r = evaluateSell({
      position,
      quote: sell(),
      costs,
      purpose: "TAKE_PROFIT",
      config: profitDefaults,
      now,
    });
    expect(r.netProfitUsdc).toBe("0.109400");
    expect(r.allowed).toBe(true);
    expect(r.allocatedCostUsdc).toBe("5.045000");
    expect(r.breakEvenPrice).not.toBeNull();
  });
  it("returns WAIT when either minimum amount or minimum ROI is not met", () => {
    expect(
      evaluateSell({
        position,
        quote: sell(),
        costs,
        purpose: "TAKE_PROFIT",
        config: { ...profitDefaults, minProfitUsdc: "0.11" },
        now,
      }).action,
    ).toBe("WAIT");
    expect(
      evaluateSell({
        position,
        quote: sell(),
        costs,
        purpose: "TAKE_PROFIT",
        config: { ...profitDefaults, minProfitPct: "0.03" },
        now,
      }).action,
    ).toBe("WAIT");
  });
  it("does not confuse a positive quote with a profitable sale", () => {
    const r = evaluateSell({
      position,
      quote: sell("5000000"),
      costs,
      purpose: "TAKE_PROFIT",
      config: profitDefaults,
      now,
    });
    expect(r.netProfitUsdc).toBe("-0.090600");
    expect(r.action).toBe("WAIT");
  });
  it.each(["STOP_LOSS", "EMERGENCY_EXIT", "RISK_REDUCTION"] as const)(
    "does not block %s at a loss",
    (purpose) => {
      const r = evaluateSell({
        position,
        quote: sell("4000000"),
        costs,
        purpose,
        config: profitDefaults,
        now,
      });
      expect(r.allowed).toBe(true);
      expect(r.netProfitUsdc).toBe("-1.090600");
    },
  );
  it("fails closed on unknown gas, quote, stale quote or mismatched coin for profit exits", () => {
    for (const quote of [
      null,
      { ...sell(), expiresAt: now },
      { ...sell(), to: "0xbad::usdc::USDC" },
    ])
      expect(
        evaluateSell({
          position,
          quote,
          costs,
          purpose: "TAKE_PROFIT",
          config: profitDefaults,
          now,
        }).allowed,
      ).toBe(false);
    expect(
      evaluateSell({
        position,
        quote: sell(),
        costs: { ...costs, gasUsdc: null },
        purpose: "TAKE_PROFIT",
        config: profitDefaults,
        now,
      }).allowed,
    ).toBe(false);
  });
  it("does not turn missing profit data into an additional stop-loss veto", () => {
    expect(
      evaluateSell({
        position,
        quote: null,
        costs: { ...costs, gasUsdc: null },
        purpose: "STOP_LOSS",
        config: profitDefaults,
        now,
      }).allowed,
    ).toBe(true);
  });
  it("allocates partial average basis without losing residual micro-USDC", () => {
    const a = allocateCost({ quantityAtomic: "3", costUsdc: "1.000000" }, "1");
    expect(a.allocatedCostUsdc).toBe("0.333334");
    const b = allocateCost(
      {
        quantityAtomic: a.remainingQuantityAtomic,
        costUsdc: a.remainingCostUsdc,
      },
      "1",
    );
    const c = allocateCost(
      {
        quantityAtomic: b.remainingQuantityAtomic,
        costUsdc: b.remainingCostUsdc,
      },
      "1",
    );
    expect(b.allocatedCostUsdc).toBe("0.333333");
    expect(c.allocatedCostUsdc).toBe("0.333333");
    expect(c.remainingCostUsdc).toBe("0.000000");
    expect(() => allocateCost(position, "2500000001")).toThrow();
  });
  it("rounds costs upward and never rounds a sub-threshold profit into approval", () => {
    const r = evaluateSell({
      position: {
        quantityAtomic: position.quantityAtomic,
        costUsdc: "5.000000",
      },
      quote: sell("5010000"),
      costs: { ...costs, additionalFeeUsdc: "0.0000001", gasUsdc: "0" },
      purpose: "TAKE_PROFIT",
      config: { ...profitDefaults, minProfitUsdc: "0.01", minProfitPct: "0" },
      now,
    });
    expect(r.netProfitUsdc).toBe("0.009999");
    expect(r.allowed).toBe(false);
    expect(
      paperCosts(sell("5010000"), { feeRate: 0.003, gasUsdc: 0.03 })
        .additionalFeeUsdc,
    ).toBe("0.015030");
  });
  it("models round-trip cost and requires projected NET profit to exceed it", () => {
    const buy = {
      ...sell("2500000000"),
      from: USDC,
      to: SUI,
      amountIn: "5000000",
      amountOut: "2500000000",
      minAmountOut: "2500000000",
    };
    const input = {
      buyQuote: buy,
      sellQuote: sell("4950000"),
      buyCosts: { ...costs, additionalFeeUsdc: "0.015000" },
      sellCosts: { ...costs, additionalFeeUsdc: "0.014850" },
      config: { ...profitDefaults, targetProfitPct: "0.04" },
      now,
    };
    const r = evaluateBuy(input);
    expect(r.roundTripCostUsdc).toBe("0.139850");
    expect(r.allowed).toBe(false);
    expect(r.targetPrice).toBe("2.080000000000");
    expect(
      evaluateBuy({
        ...input,
        config: { ...input.config, targetProfitPct: "0.2" },
      }).allowed,
    ).toBe(true);
  });
  it("rejects unknown acquisition costs and unknown projected exit costs", () => {
    expect(() =>
      recordAcquisition({
        quantityAtomic: "1",
        inputUsdc: "1",
        additionalFeeUsdc: "0",
        gasUsdc: null,
        dexFeeUsdc: null,
        source: "PAPER_MODEL",
      }),
    ).toThrow();
  });
  it("uses an earlier strategy take-profit price instead of assuming a later, more profitable exit", () => {
    const buy = {
      ...sell("2500000000"),
      from: USDC,
      to: SUI,
      amountIn: "5000000",
      amountOut: "2500000000",
      minAmountOut: "2500000000",
    };
    const r = evaluateBuy({
      buyQuote: buy,
      sellQuote: sell("4950000"),
      buyCosts: { ...costs, additionalFeeUsdc: "0.015000" },
      sellCosts: { ...costs, additionalFeeUsdc: "0.014850" },
      config: { ...profitDefaults, targetProfitPct: "0.2" },
      strategyTargetPrice: "2.01",
      now,
    });
    expect(r.allowed).toBe(false);
    expect(r.targetPrice).toBe("2.010000000000");
  });
  it.each(["STRATEGY_EXIT", "STOP_LOSS", "EMERGENCY_EXIT"] as const)(
    "preserves losing %s exits",
    (purpose) => {
      expect(
        evaluateSell({
          position,
          quote: sell("4000000"),
          costs,
          purpose,
          config: profitDefaults,
          now,
        }).allowed,
      ).toBe(true);
    },
  );
  it("rejects a profitable quote after a gas spike", () => {
    const input = {
      position,
      quote: sell(),
      costs,
      purpose: "TAKE_PROFIT" as const,
      config: profitDefaults,
      now,
    };
    expect(evaluateSell(input).allowed).toBe(true);
    expect(
      evaluateSell({ ...input, costs: { ...costs, gasUsdc: "0.2" } }).allowed,
    ).toBe(false);
  });
  it("uses the same pure calculation for PAPER and future LIVE records", () => {
    const input = {
      position,
      quote: sell(),
      costs,
      purpose: "TAKE_PROFIT" as const,
      config: profitDefaults,
      now,
    };
    const paper = evaluateSell(input);
    const live = evaluateSell({
      ...input,
      costs: { ...costs, source: "LIVE_ACTUAL" },
    });
    expect(live.netProfitUsdc).toBe(paper.netProfitUsdc);
    expect(live.breakEvenPrice).toBe(paper.breakEvenPrice);
  });
  it("disabling thresholds still rejects unknown gas and missing quotes", () => {
    const input = {
      position,
      quote: sell("4000000"),
      costs,
      purpose: "TAKE_PROFIT" as const,
      config: { ...profitDefaults, enabled: false },
      now,
    };
    expect(evaluateSell(input).allowed).toBe(true);
    expect(
      evaluateSell({ ...input, costs: { ...costs, gasUsdc: null } }).allowed,
    ).toBe(false);
    expect(evaluateSell({ ...input, quote: null }).allowed).toBe(false);
  });
  it("averages multiple purchases including all purchase fees", () => {
    const paper = new PaperTrading();
    const q = {
      ...sell("2500000000"),
      from: USDC,
      to: SUI,
      amountIn: "5000000",
      amountOut: "2500000000",
      minAmountOut: "2500000000",
    };
    const first = paper.fill(
      "a",
      "BUY",
      q,
      initialPortfolio(now),
      defaults,
      now,
    );
    const second = paper.fill(
      "b",
      "BUY",
      { ...q, amountOut: "2000000000", minAmountOut: "2000000000" },
      first.portfolio,
      defaults,
      now,
    );
    expect(second.portfolio.quantityAtomic).toBe("4500000000");
    expect(second.portfolio.costBasisUsdc).toBe("10.090000");
    expect(
      allocateCost(
        {
          quantityAtomic: "4500000000",
          costUsdc: second.portfolio.costBasisUsdc!,
        },
        "2250000000",
      ).allocatedCostUsdc,
    ).toBe("5.045000");
  });
});
