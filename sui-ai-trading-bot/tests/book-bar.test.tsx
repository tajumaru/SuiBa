import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BookBar, bookBarModel } from "../apps/dashboard/src/BookBar.tsx";

describe("bookBarModel", () => {
  it("splits the notional share and names the heavy side", () => {
    const buy = bookBarModel(0.3);
    expect(buy.bidPct).toBe(65);
    expect(buy.askPct).toBe(35);
    expect(buy.side).toBe("buy");
    expect(buy.sideWord).toBe("買い優勢");
    expect(buy.fillPct).toBeCloseTo(15, 6);
    const sell = bookBarModel(-0.6);
    expect(sell.bidPct).toBe(20);
    expect(sell.side).toBe("sell");
    expect(bookBarModel(0.02).side).toBe("even");
    expect(bookBarModel(42).bidPct).toBe(100);
  });
});

describe("BookBar", () => {
  it("renders the split and leans the liquid toward the heavy side", () => {
    const html = renderToStaticMarkup(<BookBar imbalance={0.3} />);
    expect(html).toContain("買い 65%");
    expect(html).toContain("売り 35%");
    expect(html).toContain("買い優勢");
    expect(html).toContain("book-bar-wave buy");
    const sellHtml = renderToStaticMarkup(<BookBar imbalance={-0.6} />);
    expect(sellHtml).toContain("book-bar-wave sell");
    expect(sellHtml).toContain("売り優勢");
  });
  it("hides itself without a sample", () => {
    expect(renderToStaticMarkup(<BookBar imbalance={null} />)).toBe("");
  });
});
