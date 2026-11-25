import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BuyLineOverlay,
  isLineApproaching,
} from "../apps/dashboard/src/PriceChartOverlays.tsx";

const line = 0.6571;
const y = (v: number) => 215 - ((v - 0.64) / (0.68 - 0.64)) * 185;

function render(hot: boolean) {
  return renderToStaticMarkup(
    createElement(BuyLineOverlay, {
      linePrice: line,
      hot,
      currentPrice: 0.6624,
      min: 0.64,
      max: 0.68,
      y,
      left: 40,
      right: 360,
    }),
  );
}

describe("isLineApproaching", () => {
  it("is true while the price falls toward a line below", () => {
    expect(isLineApproaching([0.67, 0.668, 0.665, 0.6624], line)).toBe(true);
  });

  it("is false while the price rises away from a line below", () => {
    expect(isLineApproaching([0.658, 0.659, 0.6605, 0.6624], line)).toBe(
      false,
    );
  });

  it("is true while the price rises toward a line above (recovery)", () => {
    expect(isLineApproaching([0.66, 0.661, 0.662, 0.6624], 0.67)).toBe(true);
  });

  it("needs at least two closes and a valid line", () => {
    expect(isLineApproaching([0.6624], line)).toBe(false);
    expect(isLineApproaching([], line)).toBe(false);
    expect(isLineApproaching([0.66, 0.6624], 0)).toBe(false);
  });
});

describe("BuyLineOverlay staging", () => {
  it("hot: the chip carries the countdown distance", () => {
    const html = render(true);
    expect(html).toContain("ライン 0.6571");
    expect(html).toContain("あと −0.80%");
  });

  it("calm: the chip is a quiet landmark, price only", () => {
    const html = render(false);
    expect(html).toContain("ライン 0.6571");
    expect(html).not.toContain("あと");
  });
});
