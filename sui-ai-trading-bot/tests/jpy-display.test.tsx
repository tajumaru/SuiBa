import { describe, expect, it } from "vitest";
import { formatJpy } from "../apps/dashboard/src/jpyDisplay.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { JpyAmount } from "../apps/dashboard/src/JpyAmount.tsx";

describe("formatJpy", () => {
  it("rounds to an integer and groups thousands", () => {
    expect(formatJpy(8, 154.3)).toBe("≈ ¥1,234");
  });

  it("places the minus sign before the yen symbol", () => {
    expect(formatJpy(-8, 154.3)).toBe("≈ −¥1,234");
  });

  it("returns null without finite amounts and a positive rate", () => {
    expect(formatJpy(1, null)).toBeNull();
    expect(formatJpy(Number.NaN, 150)).toBeNull();
    expect(formatJpy(1, 0)).toBeNull();
  });
});

describe("JpyAmount", () => {
  it("uses the existing small muted class beside an amount", () => {
    expect(
      renderToStaticMarkup(<JpyAmount usdc={8} usdJpy={154.3} />),
    ).toBe('<small class="overview-sub"> ≈ ¥1,234</small>');
  });

  it("renders no placeholder when the rate is unavailable", () => {
    expect(renderToStaticMarkup(<JpyAmount usdc={8} usdJpy={null} />)).toBe("");
  });
});
