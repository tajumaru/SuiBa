import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PortfolioMix } from "../apps/dashboard/src/PortfolioMix.tsx";
import {
  portfolioMixModel,
  priceText,
  signedMoney,
} from "../apps/dashboard/src/portfolioMix.ts";

describe("portfolioMixModel", () => {
  it("splits the total into cash and asset value at the current price", () => {
    const m = portfolioMixModel({
      usdc: 90,
      baseQty: 10,
      price: 1,
      costBasis: 9.5,
    });
    expect(m?.total).toBe(100);
    expect(m?.usdcPct).toBe(90);
    expect(m?.basePct).toBe(10);
    expect(m?.baseValue).toBe(10);
    expect(m?.gain).toBeCloseTo(0.5);
  });

  it("revalues the holding with the price while the cash stays put", () => {
    const before = portfolioMixModel({
      usdc: 90,
      baseQty: 10,
      price: 1,
      costBasis: 10,
    });
    const after = portfolioMixModel({
      usdc: 90,
      baseQty: 10,
      price: 1.1,
      costBasis: 10,
    });
    expect(before?.total).toBe(100);
    expect(after?.total).toBeCloseTo(101);
    expect(after?.gain).toBeCloseTo(1);
  });

  it("has no gain to show without a holding", () => {
    const m = portfolioMixModel({
      usdc: 100,
      baseQty: 0,
      price: 0.86,
      costBasis: 0,
    });
    expect(m?.usdcPct).toBe(100);
    expect(m?.gain).toBeNull();
  });

  it("renders nothing without a usable price", () => {
    expect(
      portfolioMixModel({ usdc: 90, baseQty: 10, price: null, costBasis: 9 }),
    ).toBeNull();
    expect(
      portfolioMixModel({ usdc: 90, baseQty: 10, price: 0, costBasis: 9 }),
    ).toBeNull();
  });

  it("formats prices and signed money", () => {
    expect(priceText(0.8659)).toBe("0.8659");
    expect(priceText(12.3)).toBe("12.30");
    expect(signedMoney(0.5)).toBe("+0.50");
    expect(signedMoney(-0.5)).toBe("−0.50");
  });
});

describe("PortfolioMix", () => {
  it("shows the bar split, the multiplication and the gain", () => {
    const html = renderToStaticMarkup(
      <PortfolioMix
        usdc={90}
        baseQty={10}
        price={1}
        costBasis={9.6}
        baseSymbol="SUI"
      />,
    );
    expect(html).toContain("資産の中身");
    expect(html).toContain("width:90%");
    expect(html).toContain("10.00 枚 × $1.0000");
    expect(html).toContain("取得 9.60");
    expect(html).toContain("+0.40");
  });

  it("shows a bare zero holding and the pair's own symbol", () => {
    const html = renderToStaticMarkup(
      <PortfolioMix
        usdc={100}
        baseQty={0}
        price={0.21}
        costBasis={0}
        baseSymbol="WAL"
      />,
    );
    expect(html).toContain("0.00 枚");
    expect(html).not.toContain("取得");
  });

  it("renders nothing without a price", () => {
    const html = renderToStaticMarkup(
      <PortfolioMix
        usdc={100}
        baseQty={0}
        price={null}
        costBasis={0}
        baseSymbol="SUI"
      />,
    );
    expect(html).toBe("");
  });
});
