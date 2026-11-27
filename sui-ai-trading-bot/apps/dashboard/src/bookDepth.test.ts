import { describe, expect, it } from "vitest";
import { bookDepthModel } from "./bookDepth.ts";

describe("bookDepthModel", () => {
  it("accumulates from the best prices and folds repeated levels into one step", () => {
    const model = bookDepthModel({
      at: 1,
      bids: [
        [99, 2],
        [99, 3],
        [98, 5],
      ],
      asks: [
        [101, 1],
        [102, 4],
      ],
    });
    expect(model).toMatchObject({
      bestBid: 99,
      bestAsk: 101,
      maxTotal: 10,
      bids: { total: 10, path: "M 27.5 100 H 27.5 V 50 H 5 V 0 H 0" },
      asks: { total: 5, path: "M 72.5 100 H 72.5 V 90 H 95 V 50 H 100" },
    });
  });

  it("rejects missing sides, out-of-order prices, and invalid quantities", () => {
    expect(bookDepthModel(null)).toBeNull();
    expect(bookDepthModel({ at: 1, bids: [], asks: [] })).toBeNull();
    expect(bookDepthModel({ at: 1, bids: [[99, 2]], asks: [] })).toBeNull();
    expect(
      bookDepthModel({
        at: 1,
        bids: [
          [99, 2],
          [100, 1],
        ],
        asks: [[101, 1]],
      }),
    ).toBeNull();
    expect(
      bookDepthModel({
        at: 1,
        bids: [[99, 2]],
        asks: [
          [102, 1],
          [101, 1],
        ],
      }),
    ).toBeNull();
    expect(
      bookDepthModel({ at: 1, bids: [[99, NaN]], asks: [[101, 1]] }),
    ).toBeNull();
  });
});
