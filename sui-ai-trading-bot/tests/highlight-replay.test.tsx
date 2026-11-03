import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  NarrationEntry,
  NarrationState,
} from "../apps/dashboard/src/agentNarration.ts";
import {
  appendHighlights,
  captureHighlights,
  highlightLabel,
  isHighlightEntry,
  loadHighlights,
  saveHighlights,
  type Highlight,
} from "../apps/dashboard/src/highlightStore.ts";
import { HighlightReplay } from "../apps/dashboard/src/HighlightReplay.tsx";

const entry = (
  id: string,
  kind: NarrationEntry["kind"],
  at: number,
  text = `entry-${id}`,
  side?: "BUY" | "SELL",
): NarrationEntry => ({ id, at, kind, text, ...(side ? { side } : {}) });
const state = (
  entries: NarrationEntry[],
  priceHistory: number[] = [1, 1.01, 1.02],
): NarrationState =>
  ({ entries, priceHistory }) as unknown as NarrationState;

describe("highlight capture", () => {
  const now = Date.UTC(2026, 10, 2, 3, 0);
  it("bookmarks fresh moments with their surrounding entries", () => {
    const prev = state([entry("a", "cycle", now - 5000)]);
    const fill = entry("b", "trade", now - 1000, "買いの約定", "BUY");
    const next = state(
      [entry("a", "cycle", now - 5000), entry("x", "cycle", now - 2000), fill],
      [1, 1.02, 1.05],
    );
    const got = captureHighlights(new Set(["a"]), next, now);
    expect(got).toHaveLength(1);
    expect(got[0].id).toBe("b");
    expect(got[0].side).toBe("BUY");
    expect(got[0].entries.map((e) => e.id)).toEqual(["a", "x", "b"]);
    expect(got[0].prices).toEqual([1, 1.02, 1.05]);
    expect(highlightLabel(got[0])).toBe("買えた！");
    void prev;
  });

  it("ignores old history, known entries and ordinary kinds", () => {
    const old = entry("old", "trade", now - 3600000, "昔の約定", "BUY");
    const known = entry("k", "watchHit", now - 1000);
    const plain = entry("p", "cycle", now - 1000);
    const next = state([old, known, plain]);
    expect(
      captureHighlights(new Set(["k"]), next, now),
    ).toHaveLength(0);
    expect(isHighlightEntry(plain)).toBe(false);
    expect(isHighlightEntry(known)).toBe(true);
  });

  it("dedupes and caps the stored list", () => {
    const h = (id: string, at: number): Highlight => ({
      id,
      at,
      kind: "watchHit",
      title: id,
      entries: [],
      prices: [],
    });
    let list = appendHighlights([], [h("1", 1)]);
    expect(appendHighlights(list, [h("1", 1)])).toBe(list);
    // A single kind floods only itself: watchHit keeps its
    // newest 6 (see HIGHLIGHT_KIND_CAPS), so the strip cannot
    // sprawl into one long row of 的中.
    for (let i = 2; i <= 35; i++) list = appendHighlights(list, [h(`${i}`, i)]);
    expect(list).toHaveLength(6);
    expect(list[0].id).toBe("30");
    // Mixed kinds still fill the store to the global cap.
    const kinds = ["trade", "nearMiss", "priceLineReached", "sellLine"];
    let mixed: Highlight[] = [];
    for (let i = 1; i <= 35; i++)
      mixed = appendHighlights(mixed, [
        { ...h(`m${i}`, i), kind: kinds[i % kinds.length] },
      ]);
    expect(mixed).toHaveLength(22);
    expect(mixed.filter((x) => x.kind === "trade")).toHaveLength(8);
  });

  it("round-trips through storage per pair and rejects junk", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const h: Highlight = {
      id: "b",
      at: 123,
      kind: "trade",
      side: "BUY",
      title: "買いの約定",
      entries: [{ id: "b", at: 123, kind: "trade", text: "買いの約定", side: "BUY" }],
      prices: [1, 2],
    };
    saveHighlights([h], "SUI", storage);
    expect(loadHighlights("SUI", storage)).toEqual([h]);
    expect(loadHighlights("WAL", storage)).toEqual([]);
    store.set("suiba.highlights.v1", "[{\"id\":1}]");
    expect(loadHighlights("SUI", storage)).toEqual([]);
  });
});

describe("HighlightReplay", () => {
  it("renders the moment, its entries and the replay framing", () => {
    const h: Highlight = {
      id: "b",
      at: Date.UTC(2026, 10, 2, 3, 5),
      kind: "trade",
      side: "BUY",
      title: "買いの約定",
      entries: [
        { id: "a", at: Date.UTC(2026, 10, 2, 3, 4), kind: "cycle", text: "様子見" },
        { id: "b", at: Date.UTC(2026, 10, 2, 3, 5), kind: "trade", text: "買いの約定", side: "BUY" },
      ],
      prices: [1, 1.01, 1.03, 1.02],
    };
    const html = renderToStaticMarkup(
      React.createElement(HighlightReplay, { highlight: h, onClose: () => {} }),
    );
    expect(html).toContain("ハイライト再演");
    expect(html).toContain("買えた！");
    expect(html).toContain("再演");
    // Entries appear one by one: the first render shows the
    // lead-in entry and step 1 of 2, not yet the moment itself.
    expect(html).toContain("様子見");
    expect(html).toContain("1 / 2");
    expect(html).toContain("highlight-replay-spark");
  });
});
