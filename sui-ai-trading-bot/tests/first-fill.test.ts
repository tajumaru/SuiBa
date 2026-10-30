import { describe, expect, it } from "vitest";
import { firstFilledBuy } from "../apps/dashboard/src/firstFill.ts";

const order = (
  side: string,
  status: string,
  timestamp: number,
  quote?: Record<string, unknown>,
) => ({ side, status, timestamp, ...(quote ? { quote } : {}) });

describe("firstFilledBuy", () => {
  it("marks the earliest filled buy (list is newest-first)", () => {
    const orders = [
      order("SELL", "FILLED", 300),
      order("BUY", "FILLED", 200, {
        amountIn: "5",
        referencePrice: 0.9,
      }),
      order("BUY", "FILLED", 100, {
        amountIn: "2",
        referencePrice: 0.88,
      }),
    ];
    const first = firstFilledBuy(orders);
    expect(first?.index).toBe(2);
    expect(first?.amountIn).toBe("2");
    expect(first?.referencePrice).toBe(0.88);
  });

  it("ignores non-filled and sell orders", () => {
    const orders = [
      order("BUY", "SKIPPED", 50),
      order("SELL", "FILLED", 40),
      order("BUY", "FILLED", 100),
    ];
    expect(firstFilledBuy(orders)?.index).toBe(2);
  });

  it("returns null when there is no filled buy", () => {
    expect(firstFilledBuy([order("SELL", "FILLED", 1)])).toBeNull();
    expect(firstFilledBuy([])).toBeNull();
  });

  it("refuses to mark at the 200-row history cap (may be truncated)", () => {
    const orders = Array.from({ length: 200 }, (_, i) =>
      order("BUY", "FILLED", 1000 - i),
    );
    expect(firstFilledBuy(orders)).toBeNull();
  });

  it("tolerates missing quote fields", () => {
    const first = firstFilledBuy([order("BUY", "FILLED", 10)]);
    expect(first).toEqual({ index: 0, amountIn: null, referencePrice: null });
  });
});
