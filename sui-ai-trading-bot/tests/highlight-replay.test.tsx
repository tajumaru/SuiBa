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
  declarationForVerdict,
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

describe("watch hit declarations", () => {
  const now = Date.UTC(2026, 10, 3, 0, 0);
  const declaration = (id: string, at: number, name = "RSI") =>
    entry(id, "cycle", at, `次は${name}を見てる。今40.0、ラインまで5。近づいたら声かけるね`);
  const hit = (id: string, at: number) =>
    entry(id, "watchHit", at, "RSI、上抜けた。44.7→49.1。ほらな、言うてたやろ");
  const filler = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) =>
      entry(`f${from + i}`, "cycle", now - 50000 + (from + i) * 1000),
    );

  it("prepends a declaration that fell outside the window", () => {
    const entries = [
      declaration("d", now - 60000),
      ...filler(10, 0),
      hit("h", now - 1000),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    expect(got).toHaveLength(1);
    expect(got[0].entries).toHaveLength(9);
    expect(got[0].entries[0].id).toBe("d");
    expect(got[0].entries.at(-1)?.id).toBe("h");
  });

  it("does not duplicate a declaration already inside the window", () => {
    const entries = [
      ...filler(3, 0),
      declaration("d", now - 5000),
      entry("x", "cycle", now - 3000),
      hit("h", now - 1000),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    expect(got[0].entries.map((e) => e.id)).toEqual([
      "f0",
      "f1",
      "f2",
      "d",
      "x",
      "h",
    ]);
  });

  it("ignores declarations of another condition and settled ones", () => {
    const other = [
      declaration("d", now - 60000, "MACD"),
      ...filler(10, 0),
      hit("h", now - 1000),
    ];
    expect(
      captureHighlights(new Set(), state(other), now)[0].entries,
    ).toHaveLength(8);
    const settled = [
      declaration("d", now - 60000),
      entry("nm", "nearMiss", now - 30000, "RSI、あと3まで来てたのに…"),
      ...filler(9, 0),
      hit("h", now - 1000),
    ];
    const hitHighlight = captureHighlights(new Set(), state(settled), now).find(
      (h) => h.id === "h",
    );
    expect(hitHighlight).toBeDefined();
    expect(hitHighlight!.entries[0].id).not.toBe("d");
    expect(hitHighlight!.entries).toHaveLength(8);
  });

  it("round-trips a nine-entry highlight through storage", () => {
    const entries = [
      declaration("d", now - 60000),
      ...filler(10, 0),
      hit("h", now - 1000),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    } as unknown as Storage;
    saveHighlights(got, "SUI", storage);
    const loaded = loadHighlights("SUI", storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].entries).toHaveLength(9);
    expect(loaded[0].entries[0].id).toBe("d");
  });
});

describe("forecast verdict declarations", () => {
  const now = Date.UTC(2026, 10, 4, 3, 0);
  const ORIGIN_A = 1762100000;
  const ORIGIN_B = 1762103600;
  const call = (
    id: string,
    at: number,
    origin: number,
  ): NarrationEntry => ({
    id,
    at,
    kind: "forecastCall",
    text: "予測を宣言：2時間で上昇 +1.2% と見てる。答え合わせは2時間後",
    forecastOrigin: origin,
  });
  const verdict = (
    id: string,
    at: number,
    origin: number | undefined,
    kind: "forecastHit" | "forecastMiss" = "forecastHit",
  ): NarrationEntry => ({
    id,
    at,
    kind,
    text:
      kind === "forecastHit"
        ? "予測、的中。上昇 +1.2% の宣言どおり、実際は +1.5%"
        : "予測は外れ。上昇 +1.2% と言ったけど、実際は -0.8%",
    ...(origin != null ? { forecastOrigin: origin } : {}),
  });
  const filler = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) =>
      entry(`f${from + i}`, "cycle", now - 50000 + (from + i) * 1000),
    );

  it("prepends the declaration that set the verdict up", () => {
    const entries = [
      call("d", now - 2 * 3600000, ORIGIN_A),
      ...filler(10, 0),
      verdict("v", now - 1000, ORIGIN_A),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    expect(got).toHaveLength(1);
    expect(got[0].kind).toBe("forecastHit");
    expect(got[0].entries).toHaveLength(9);
    expect(got[0].entries[0].id).toBe("d");
    expect(got[0].entries.at(-1)?.id).toBe("v");
    expect(highlightLabel(got[0])).toBe("予測的中");
  });

  it("pairs a miss the same way, with the miss label", () => {
    const entries = [
      call("d", now - 2 * 3600000, ORIGIN_A),
      ...filler(10, 0),
      verdict("v", now - 1000, ORIGIN_A, "forecastMiss"),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    expect(got).toHaveLength(1);
    expect(got[0].entries[0].id).toBe("d");
    expect(highlightLabel(got[0])).toBe("予測外れ");
  });

  it("does not duplicate a declaration already inside the window", () => {
    const entries = [
      ...filler(3, 0),
      call("d", now - 5000, ORIGIN_A),
      entry("x", "cycle", now - 3000),
      verdict("v", now - 1000, ORIGIN_A),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    expect(got[0].entries.map((e) => e.id)).toEqual([
      "f0",
      "f1",
      "f2",
      "d",
      "x",
      "v",
    ]);
  });

  it("pairs each verdict with its own declaration when two forecasts are outstanding", () => {
    const entries = [
      call("da", now - 2 * 3600000, ORIGIN_A),
      call("db", now - 3600000, ORIGIN_B),
      ...filler(10, 0),
      verdict("va", now - 2000, ORIGIN_A),
      verdict("vb", now - 1000, ORIGIN_B, "forecastMiss"),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    expect(got).toHaveLength(2);
    expect(got[0].entries[0].id).toBe("da");
    expect(got[0].entries.some((e) => e.id === "db")).toBe(false);
    expect(got[1].entries[0].id).toBe("db");
    expect(got[1].entries.some((e) => e.id === "da")).toBe(false);
  });

  it("a declaration alone never becomes a highlight", () => {
    const entries = [call("d", now - 1000, ORIGIN_A), ...filler(3, 0)];
    expect(captureHighlights(new Set(), state(entries), now)).toHaveLength(0);
    expect(isHighlightEntry(call("d", now, ORIGIN_A))).toBe(false);
    expect(isHighlightEntry(verdict("v", now, ORIGIN_A))).toBe(true);
    expect(isHighlightEntry(verdict("v", now, ORIGIN_A, "forecastMiss"))).toBe(
      true,
    );
  });

  it("a verdict from before origins were recorded finds no declaration", () => {
    const entries = [
      call("d", now - 2 * 3600000, ORIGIN_A),
      ...filler(10, 0),
      verdict("v", now - 1000, undefined),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    expect(got).toHaveLength(1);
    expect(got[0].entries).toHaveLength(8);
    expect(got[0].entries[0].id).not.toBe("d");
    expect(declarationForVerdict(entries, entries.length - 1)).toBeNull();
  });

  it("never borrows another pair's declaration", () => {
    // The SUI list holds the verdict; the same origin's
    // declaration exists only in the WAL pair's own list.
    const suiEntries = [
      ...filler(10, 0),
      verdict("v", now - 1000, ORIGIN_A),
    ];
    const walEntries = [call("d", now - 2 * 3600000, ORIGIN_A)];
    const got = captureHighlights(new Set(), state(suiEntries), now);
    expect(got).toHaveLength(1);
    expect(got[0].entries).toHaveLength(8);
    expect(got[0].entries.some((e) => e.id === "d")).toBe(false);
    // And the WAL list on its own has no moment to capture.
    expect(captureHighlights(new Set(), state(walEntries), now)).toHaveLength(
      0,
    );
  });

  it("round-trips a nine-entry verdict highlight through storage", () => {
    const entries = [
      call("d", now - 2 * 3600000, ORIGIN_A),
      ...filler(10, 0),
      verdict("v", now - 1000, ORIGIN_A),
    ];
    const got = captureHighlights(new Set(), state(entries), now);
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    } as unknown as Storage;
    saveHighlights(got, "SUI", storage);
    const loaded = loadHighlights("SUI", storage);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].entries).toHaveLength(9);
    expect(loaded[0].entries[0].id).toBe("d");
  });
});
