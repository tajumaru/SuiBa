import { describe, expect, it } from "vitest";
import {
  advanceBookWalls,
  detectBookWalls,
  type BookWallState,
} from "../apps/dashboard/src/narration/book.ts";
import { bookTopLevels } from "../packages/market-data/src/deepbook.ts";
import type { BookLevels } from "../packages/shared/src/index.ts";

const T0 = 1_700_000_000_000;
const plainBids: [number, number][] = [
  [0.9342, 100],
  [0.9341, 120],
  [0.934, 90],
  [0.9339, 110],
  [0.9338, 100],
];
const plainAsks: [number, number][] = [
  [0.9344, 100],
  [0.9345, 110],
  [0.9346, 95],
  [0.9347, 105],
  [0.9348, 100],
];
const book = (
  at: number,
  bids = plainBids,
  asks = plainAsks,
): BookLevels => ({ at, bids, asks });
const askWallAsks: [number, number][] = [
  [0.9344, 100],
  [0.9345, 110],
  [0.9346, 840],
  [0.9347, 105],
  [0.9348, 100],
];
const empty = (): BookWallState => ({
  walls: [],
  bookAt: null,
  adopted: false,
  lastEntryAt: null,
  cooldowns: {},
});
const adopted = (at = T0): BookWallState => {
  const r = advanceBookWalls(empty(), book(at), "SUI", at);
  expect(r.texts).toEqual([]);
  return r.state;
};

describe("bookTopLevels", () => {
  it("slices the top levels of each side, best first", () => {
    const bids = Array.from({ length: 20 }, (_, i) => [1 - i * 0.001, i + 1]);
    const asks = Array.from({ length: 20 }, (_, i) => [1.01 + i * 0.001, i + 1]);
    const top = bookTopLevels({ bids, asks });
    expect(top.bids).toHaveLength(12);
    expect(top.asks).toHaveLength(12);
    expect(top.bids[0]).toEqual([1, 1]);
    expect(top.asks[0]).toEqual([1.01, 1]);
  });
});

describe("detectBookWalls", () => {
  it("finds a level dwarfing the side's median, near the mid", () => {
    const walls = detectBookWalls(book(T0, plainBids, askWallAsks), T0);
    expect(walls).toHaveLength(1);
    expect(walls[0].side).toBe("ask");
    expect(walls[0].price).toBe(0.9346);
    expect(walls[0].multiple).toBeGreaterThan(7);
  });

  it("ignores big levels far from the mid and thin sides", () => {
    const farAsks: [number, number][] = [
      [0.9344, 100],
      [0.9345, 110],
      [0.9346, 95],
      [0.99, 5000],
      [0.9348, 100],
    ];
    expect(detectBookWalls(book(T0, plainBids, farAsks), T0)).toEqual([]);
    const thinAsks: [number, number][] = [
      [0.9344, 100],
      [0.9345, 5000],
    ];
    expect(detectBookWalls(book(T0, plainBids, thinAsks), T0)).toEqual([]);
    expect(detectBookWalls(book(T0), T0)).toEqual([]);
  });
});

describe("advanceBookWalls", () => {
  it("adopts the first snapshot silently and dedupes by book time", () => {
    const first = advanceBookWalls(empty(), book(T0, plainBids, askWallAsks), "SUI", T0);
    expect(first.texts).toEqual([]);
    expect(first.state.walls).toHaveLength(1);
    expect(first.state.walls[0].announced).toBe(false);
    const again = advanceBookWalls(first.state, book(T0, plainBids, askWallAsks), "SUI", T0 + 1000);
    expect(again.state).toBe(first.state);
    // The adopted wall leaves silently too.
    const gone = advanceBookWalls(first.state, book(T0 + 45000), "SUI", T0 + 45000);
    expect(gone.texts).toEqual([]);
    expect(gone.state.walls).toEqual([]);
  });

  it("tells a wall's appearance with its size and multiple", () => {
    const state = adopted();
    const r = advanceBookWalls(state, book(T0 + 45000, plainBids, askWallAsks), "SUI", T0 + 45000);
    expect(r.texts).toHaveLength(1);
    expect(r.texts[0]).toContain("$0.9346 に売り壁 840 SUI");
    expect(r.texts[0]).toContain("約8倍");
    expect(r.state.walls[0].announced).toBe(true);
    // Standing walls stay silent.
    const still = advanceBookWalls(r.state, book(T0 + 90000, plainBids, askWallAsks), "SUI", T0 + 90000);
    expect(still.texts).toEqual([]);
  });

  it("tells a vanishing, then keeps the level on cooldown", () => {
    let state = adopted();
    state = advanceBookWalls(state, book(T0 + 45000, plainBids, askWallAsks), "SUI", T0 + 45000).state;
    const gone = advanceBookWalls(state, book(T0 + 400000), "SUI", T0 + 400000);
    expect(gone.texts).toHaveLength(1);
    expect(gone.texts[0]).toContain("$0.9346 の売り壁、消えた");
    // Reappearing inside the cooldown is tracked, not told.
    const back = advanceBookWalls(gone.state, book(T0 + 445000, plainBids, askWallAsks), "SUI", T0 + 445000);
    expect(back.texts).toEqual([]);
    expect(back.state.walls[0].announced).toBe(false);
  });

  it("tells a breach when the price crosses an announced wall", () => {
    let state = adopted();
    state = advanceBookWalls(state, book(T0 + 45000, plainBids, askWallAsks), "SUI", T0 + 45000).state;
    const crossedBids: [number, number][] = [
      [0.9347, 100],
      [0.9346, 120],
      [0.9345, 90],
      [0.9344, 110],
      [0.9343, 100],
    ];
    const crossedAsks: [number, number][] = [
      [0.9349, 100],
      [0.935, 110],
      [0.9351, 95],
      [0.9352, 105],
      [0.9353, 100],
    ];
    const r = advanceBookWalls(state, book(T0 + 90000, crossedBids, crossedAsks), "SUI", T0 + 90000);
    expect(r.texts).toEqual(["売り壁 $0.9346 を上に抜けた"]);
  });

  it("spaces appearances by the entry interval", () => {
    const state = adopted();
    const bidWallBids: [number, number][] = [
      [0.9342, 900],
      [0.9341, 120],
      [0.934, 90],
      [0.9339, 110],
      [0.9338, 100],
    ];
    const first = advanceBookWalls(state, book(T0 + 45000, bidWallBids, plainAsks), "SUI", T0 + 45000);
    expect(first.texts).toHaveLength(1);
    expect(first.texts[0]).toContain("買い壁");
    // A second wall one minute later is tracked silently.
    const both = advanceBookWalls(
      first.state,
      book(T0 + 105000, bidWallBids, askWallAsks),
      "SUI",
      T0 + 105000,
    );
    expect(both.texts).toEqual([]);
    expect(both.state.walls).toHaveLength(2);
  });
});
