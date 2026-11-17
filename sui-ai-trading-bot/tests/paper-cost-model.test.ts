import { expect, it } from "vitest";
import {
  atomic,
  defaults,
  PAPER_FEE_RATE,
  PAPER_GAS_USDC,
  PAPER_SLIPPAGE_RATE,
  SUI,
  USDC,
  type QuoteResult,
} from "../packages/shared/src/index.ts";
import {
  initialPortfolio,
  PaperTrading,
} from "../packages/paper-trading/src/index.ts";

const now = 1_800_000_000_000;
const impact = 0.0006;

function quote(
  side: "BUY" | "SELL",
  amountIn: string,
  amountOut: string,
): QuoteResult {
  return {
    id: side,
    from: side === "BUY" ? USDC : SUI,
    to: side === "BUY" ? SUI : USDC,
    amountIn,
    amountOut,
    minAmountOut: amountOut,
    slippage: PAPER_SLIPPAGE_RATE,
    referencePrice: 2,
    priceImpact: impact,
    liquid: true,
    createdAt: now,
    expiresAt: now + 15_000,
    route: ["measured-book"],
    source: "test",
  };
}

it("uses the recalibrated PAPER cost defaults", () => {
  expect(PAPER_FEE_RATE).toBe(0.001);
  expect(PAPER_GAS_USDC).toBe(0.005);
  expect(defaults.feeRate).toBe(PAPER_FEE_RATE);
  expect(defaults.gasUsdc).toBe(PAPER_GAS_USDC);
  expect(PAPER_SLIPPAGE_RATE).toBe(0);
  expect(defaults.maxSlippage).toBe(0.003);
});

it("keeps a measured-impact 10 USDC round trip within the 0.3-0.45% target", () => {
  const paper = new PaperTrading();
  const buyOutput = atomic((10 / 2) * (1 - impact), SUI);
  const buy = paper.fill(
    "buy",
    "BUY",
    quote("BUY", atomic(10, USDC), buyOutput),
    initialPortfolio(now),
    defaults,
    now,
  );
  const sellOutput = atomic(
    (Number(buyOutput) / 1e9) * 2 * (1 - impact),
    USDC,
  );
  const sell = paper.fill(
    "sell",
    "SELL",
    quote("SELL", buyOutput, sellOutput),
    buy.portfolio,
    defaults,
    now,
  );
  const roundTripCostPct = ((100 - sell.portfolio.usdc) / 10) * 100;

  expect(roundTripCostPct).toBeCloseTo(0.41986, 4);
  expect(roundTripCostPct).toBeGreaterThanOrEqual(0.3);
  expect(roundTripCostPct).toBeLessThanOrEqual(0.45);
  expect(buy.trade.slippage).toBe(0);
  expect(sell.trade.slippage).toBe(0);
  expect(buy.trade.priceImpact).toBe(impact);
  expect(sell.trade.priceImpact).toBe(impact);
});
