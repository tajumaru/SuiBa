import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RealPortfolioMix } from "../apps/dashboard/src/RealPortfolioMix.tsx";

const render = (balances: { SUI: number; DBUSDC: number; DEEP: number }) =>
  renderToStaticMarkup(
    <RealPortfolioMix
      balances={balances as never}
      network={"testnet" as never}
      price={0.65}
    />,
  );

describe("REAL asset breakdown", () => {
  it("shows only the insufficient-balance warning when every asset is zero", () => {
    const html = render({ SUI: 0, DBUSDC: 0, DEEP: 0 });
    expect(html).toContain("残高不足：資産がすべて 0 です");
    expect(html).not.toContain("合計");
    expect(html).not.toContain("pm-rows");
  });
  it("shows the breakdown when any asset is non-zero", () => {
    const html = render({ SUI: 0, DBUSDC: 1.5, DEEP: 0 });
    expect(html).toContain("合計");
    expect(html).not.toContain("残高不足");
  });
});
