import { describe, expect, it } from "vitest";
import { rsi, rsiTargetPrice } from "../packages/indicators/src/index.ts";

// A rising-then-cooling close series whose RSI sits above a 45
// target, so a lower next close can pull RSI down to the line.
const closes = [
  100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114,
  113, 112, 111, 110, 109, 108,
];

describe("rsiTargetPrice", () => {
  it("solves the close at which the next candle's RSI equals the target", () => {
    const target = 45;
    const line = rsiTargetPrice(closes, target);
    expect(line).not.toBeNull();
    expect(line!).toBeLessThan(closes.at(-1)!);
    expect(line!).toBeGreaterThan(0);
    expect(rsi([...closes, line!])).toBeCloseTo(target, 6);
  });

  it("is null when RSI is already at or below the target", () => {
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i * 2);
    expect(rsi(falling)).toBeLessThan(45);
    expect(rsiTargetPrice(falling, 45)).toBeNull();
  });

  it("is null without enough data or for a degenerate target", () => {
    expect(rsiTargetPrice([1, 2, 3], 45)).toBeNull();
    expect(rsiTargetPrice(closes, 0)).toBeNull();
    expect(rsiTargetPrice(closes, 100)).toBeNull();
  });
});
