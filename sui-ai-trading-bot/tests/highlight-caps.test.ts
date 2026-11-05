import { describe, expect, it } from "vitest";
import {
  appendHighlights,
  capHighlights,
  loadHighlights,
  saveHighlights,
  type Highlight,
} from "../apps/dashboard/src/highlightStore.ts";

function highlight(kind: string, at: number): Highlight {
  return {
    id: `${kind}-${at}`,
    at,
    kind,
    title: `${kind} at ${at}`,
    entries: [],
    prices: [],
  };
}

describe("highlight per-kind caps", () => {
  it("a flood of hits evicts its own kind, never the rare moments", () => {
    let list: Highlight[] = [];
    list = appendHighlights(list, [
      highlight("trade", 100),
      highlight("priceLineReached", 200),
      highlight("nearMiss", 300),
    ]);
    const hits = Array.from({ length: 20 }, (_, i) =>
      highlight("watchHit", 1000 + i * 1000),
    );
    list = appendHighlights(list, hits);
    const byKind = (k: string) => list.filter((h) => h.kind === k);
    expect(byKind("watchHit")).toHaveLength(6);
    // The newest hits survive.
    expect(byKind("watchHit").at(-1)?.at).toBe(20000);
    expect(byKind("trade")).toHaveLength(1);
    expect(byKind("priceLineReached")).toHaveLength(1);
    expect(byKind("nearMiss")).toHaveLength(1);
    expect(list.length).toBeLessThanOrEqual(30);
  });

  it("keeps the newest of each kind in chronological order", () => {
    const flooded = [
      ...Array.from({ length: 9 }, (_, i) => highlight("sellLine", i + 1)),
      ...Array.from({ length: 12 }, (_, i) => highlight("trade", 100 + i)),
    ];
    const capped = capHighlights(flooded);
    expect(capped.filter((h) => h.kind === "sellLine")).toHaveLength(4);
    expect(capped.filter((h) => h.kind === "trade")).toHaveLength(10);
    const ats = capped.map((h) => h.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    // The oldest sell lines (1..5) are gone; the newest remain.
    expect(capped.some((h) => h.kind === "sellLine" && h.at === 1)).toBe(false);
    expect(capped.some((h) => h.kind === "sellLine" && h.at === 9)).toBe(true);
  });

  it("caps forecast verdicts per kind, hits and misses separately", () => {
    const flooded = [
      ...Array.from({ length: 8 }, (_, i) =>
        highlight("forecastHit", 100 + i),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        highlight("forecastMiss", 200 + i),
      ),
      highlight("trade", 300),
    ];
    const capped = capHighlights(flooded);
    const hits = capped.filter((h) => h.kind === "forecastHit");
    const misses = capped.filter((h) => h.kind === "forecastMiss");
    expect(hits).toHaveLength(3);
    expect(misses).toHaveLength(3);
    // The newest verdicts survive.
    expect(hits.at(-1)?.at).toBe(107);
    expect(misses.at(-1)?.at).toBe(207);
    expect(capped.filter((h) => h.kind === "trade")).toHaveLength(1);
  });

  it("trims a flooded stored list on load", () => {
    let value: string | null = null;
    const storage = {
      getItem: () => value,
      setItem: (_k: string, v: string) => {
        value = v;
      },
    };
    const flooded = Array.from({ length: 25 }, (_, i) =>
      highlight("watchHit", 1000 + i),
    );
    saveHighlights(flooded, "SUI", storage);
    const loaded = loadHighlights("SUI", storage);
    expect(loaded.filter((h) => h.kind === "watchHit")).toHaveLength(6);
  });
});
