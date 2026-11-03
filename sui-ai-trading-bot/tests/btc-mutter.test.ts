import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  BtcSampler,
  createBtcPriceFetcher,
} from "../apps/worker/src/btcInfo.ts";
import {
  advanceNarration,
  btcMutter,
  emptyNarrationState,
} from "../apps/dashboard/src/agentNarration.ts";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";
import type { BtcInfo } from "../packages/shared/src/index.ts";
import {
  persistNarration,
  restoreNarration,
} from "../apps/dashboard/src/narrationStorage.ts";
import { AgentFeedEntryRow } from "../apps/dashboard/src/AgentFeedEntryRow.tsx";

const HOUR = 3600 * 1000;
const T0 = Date.UTC(2026, 10, 3, 4, 0, 0);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BtcSampler", () => {
  it("has no hourly change until an hour of samples exists", () => {
    const s = new BtcSampler();
    expect(s.observe(100, T0).change1hPct).toBeNull();
    expect(s.observe(101, T0 + 30 * 60_000).change1hPct).toBeNull();
  });

  it("measures the change against the newest sample an hour old", () => {
    const s = new BtcSampler();
    s.observe(100, T0);
    s.observe(100.5, T0 + 30 * 60_000); // too new to be the reference
    const info = s.observe(101.3, T0 + 61 * 60_000);
    expect(info.change1hPct).toBeCloseTo(1.3);
    expect(info.price).toBe(101.3);
  });

  it("forgets samples past the retention window", () => {
    const s = new BtcSampler();
    s.observe(100, T0);
    // Four hours later the only reference candidate is pruned.
    expect(s.observe(90, T0 + 4 * HOUR).change1hPct).toBeNull();
  });
});

describe("createBtcPriceFetcher", () => {
  it("parses the ticker price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ price: "68420.00" }),
      })),
    );
    await expect(createBtcPriceFetcher()()).resolves.toBe(68420);
  });

  it("fails soft on HTTP errors and garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(createBtcPriceFetcher()()).resolves.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ price: "not-a-number" }),
      })),
    );
    await expect(createBtcPriceFetcher()()).resolves.toBeNull();
  });
});

const btc = (overrides: Partial<BtcInfo>): BtcInfo => ({
  price: 68420,
  change1hPct: 1.3,
  at: T0,
  ...overrides,
});

describe("btcMutter", () => {
  it("mutters an hourly rise with the facts", () => {
    expect(btcMutter(btc({}), null, T0)?.text).toBe(
      "BTCが上がってきた！ 1時間で+1.3%（$68,420）",
    );
  });

  it("escalates past ±2% and phrases a fall plainly", () => {
    expect(
      btcMutter(btc({ price: 66980, change1hPct: -2.1 }), null, T0)?.text,
    ).toBe("BTCが急に下がってきた… 1時間で-2.1%（$66,980）");
    expect(btcMutter(btc({ change1hPct: -1.4 }), null, T0)?.text).toContain(
      "BTCが下がってきた…",
    );
  });

  it("stays quiet below the threshold, without a change, or when stale", () => {
    expect(btcMutter(btc({ change1hPct: 0.9 }), null, T0)).toBeNull();
    expect(btcMutter(btc({ change1hPct: null }), null, T0)).toBeNull();
    expect(btcMutter(btc({}), null, T0 + 4 * 60_000)).toBeNull();
    expect(btcMutter(null, null, T0)).toBeNull();
  });

  it("cools down per direction for two hours, but a flip speaks", () => {
    const last = { at: T0, direction: "up" as const };
    expect(btcMutter(btc({ at: T0 + HOUR }), last, T0 + HOUR)).toBeNull();
    expect(
      btcMutter(btc({ change1hPct: -1.5, at: T0 + HOUR }), last, T0 + HOUR),
    ).not.toBeNull();
    expect(
      btcMutter(btc({ at: T0 + 2 * HOUR + 1 }), last, T0 + 2 * HOUR + 1),
    ).not.toBeNull();
  });
});

function ops(
  overrides: Partial<OperationsSnapshot> & Record<string, unknown>,
): OperationsSnapshot {
  return {
    status: "STOPPED",
    events: [],
    candidates: [],
    decision: null,
    safety: null,
    stopReason: null,
    ...overrides,
  } as unknown as OperationsSnapshot;
}

describe("advanceNarration BTC mutters", () => {
  it("posts one entry and remembers it across advances", () => {
    const prev = {
      ...emptyNarrationState(),
      initialized: true,
      entries: [],
    };
    const next = advanceNarration(
      prev,
      ops({}),
      "sleeping",
      T0,
      undefined,
      btc({}),
    );
    const entries = next.entries.filter((e) => e.kind === "btc");
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain("BTCが上がってきた！");
    expect(next.lastBtcMutter).toEqual({ at: T0, direction: "up" });
    const again = advanceNarration(next, ops({}), "sleeping", T0 + 1000, undefined, btc({}));
    expect(again.entries.filter((e) => e.kind === "btc")).toHaveLength(1);
  });
});

describe("BTC mutter rendering and storage", () => {
  it("renders the orange BTC tag", () => {
    const html = renderToStaticMarkup(
      createElement(AgentFeedEntryRow, {
        entry: {
          id: "e0",
          at: T0,
          kind: "btc",
          text: "BTCが上がってきた！ 1時間で+1.3%（$68,420）",
        },
        justBought: false,
      }),
    );
    expect(html).toContain("BTC");
    expect(html).toContain('class="agent-feed-entry-tag btc"');
  });

  it("round-trips the mutter memory and defaults it for old saves", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    const state = {
      ...emptyNarrationState(),
      lastBtcMutter: { at: T0, direction: "down" as const },
    };
    persistNarration(state, storage);
    expect(restoreNarration(storage).lastBtcMutter).toEqual({
      at: T0,
      direction: "down",
    });
    const raw = JSON.parse(backing.get("suiba.narration.v1")!) as Record<
      string,
      unknown
    >;
    delete raw.lastBtcMutter;
    backing.set("suiba.narration.v1", JSON.stringify(raw));
    expect(restoreNarration(storage).lastBtcMutter).toBeNull();
  });

  it("restores a state holding btc and monthlyReport entries", () => {
    // Regression guard: a narration kind missing from the
    // storage enum fails the whole parse and wipes the feed.
    // monthlyReport shipped without an enum entry — the first
    // real finalisation (Dec 1) would have reset everything.
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    const entry = (id: string, kind: "btc" | "monthlyReport") => ({
      id,
      at: T0,
      kind,
      text: "x",
    });
    const state = {
      ...emptyNarrationState(),
      entries: [entry("e1", "btc"), entry("e2", "monthlyReport")],
      nextEntryId: 2,
    };
    persistNarration(state, storage);
    const restored = restoreNarration(storage);
    expect(restored.entries.map((e) => e.kind)).toEqual([
      "btc",
      "monthlyReport",
    ]);
  });
});
