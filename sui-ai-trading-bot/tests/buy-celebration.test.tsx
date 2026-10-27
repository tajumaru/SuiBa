import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import {
  advanceNarration,
  BUY_CELEBRATION_MS,
  buyCelebrationActive,
  emptyNarrationState,
  findNewBuyEntry,
  isBuyTradeEntry,
  type NarrationEntry,
} from "../apps/dashboard/src/agentNarration.ts";
import {
  AgentFeedEntryRow,
  AgentHeaderAvatar,
} from "../apps/dashboard/src/AgentNarration.tsx";
import { PriceTicker } from "../apps/dashboard/src/PriceTicker.tsx";
import type { TradingDecision } from "../packages/shared/src/index.ts";
import type { CandidateAudit } from "../packages/shared/src/operations.ts";

const NOW = 1_800_000_000_000;
const databases: BotDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.close();
  // The reduced-motion stub must not leak into other renders.
  delete (globalThis as { window?: unknown }).window;
});

function decision(): TradingDecision {
  const conditions = {
    hasPosition: false,
    stopLoss: false,
    takeProfit: false,
    latestVolumePositive: true,
    previousVolumePositive: true,
    volumeChangeExceeded: false,
    emaUp: false,
    emaGapShrinking: false,
    rsiRecovery: false,
    histogramImproving: false,
    emaDown: true,
    rsiReversal: false,
    histogramDeclining: true,
  };
  return {
    action: "WAIT",
    confidence: 0,
    reason: "条件未成立",
    stopLossPct: 0.02,
    takeProfitPct: 0.03,
    timestamp: new Date(NOW - 60_000).toISOString(),
    evidence: {
      version: 1,
      evaluatedAt: NOW - 60_000,
      candleTimestamp: (NOW - 600_000) / 1000,
      previousCandleTimestamp: (NOW - 900_000) / 1000,
      inputs: {
        price: 2.4,
        latestVolume: 1000,
        previousVolume: 900,
        entryPrice: null,
        current: {
          ema20: 2.38,
          ema50: 2.42,
          rsi: 44,
          macd: 0.001,
          signal: 0.002,
          histogram: -0.003,
          atr: 0.02,
          volumeChange: 0.05,
          priceChange: 0.001,
        },
        previous: {
          ema20: 2.37,
          ema50: 2.42,
          rsi: 42,
          macd: 0.0005,
          signal: 0.002,
          histogram: -0.002,
          atr: 0.02,
          volumeChange: 0.03,
          priceChange: 0,
        },
      },
      thresholds: {
        oversold: 30,
        overbought: 70,
        maxVolumeChange: 3,
        stopLossPct: 0.02,
        takeProfitPct: 0.03,
      },
      conditions,
      selectedRule: "NO_SIGNAL",
    },
  };
}

function fixture() {
  const db = new BotDatabase(":memory:");
  databases.push(db);
  const monitor = new OperationMonitor(db);
  return { db, monitor };
}

function runningSnapshot(db: BotDatabase, monitor: OperationMonitor) {
  db.set("decision", decision());
  const d = monitor.snapshot(NOW);
  d.status = "RUNNING";
  d.safety.botState = "RUNNING";
  d.safety.connectivity = "HEALTHY";
  d.safety.ordersAllowed = true;
  d.timing.dataStatus = "FRESH";
  d.timing.transportRecent = true;
  d.timing.lastTransportSuccessAt = NOW - 1_000;
  d.lastHeartbeatAt = NOW - 5_000;
  d.lastMarketClosedAt = NOW - 300_000;
  return d;
}

function candidate(overrides: Partial<CandidateAudit>): CandidateAudit {
  return {
    id: "cand-1",
    orderId: "order-1",
    timestamp: NOW - 30_000,
    createdAt: NOW - 30_000,
    side: "BUY",
    requestedInputAtomic: "10000000",
    quantityAtomic: "500000000",
    quotePriceUsdc: "2.4312",
    quoteExpiresAt: null,
    acquisitionCostUsdc: null,
    expectedSaleUsdc: null,
    saleModel: null,
    dexFeeUsdc: null,
    gasUsdc: null,
    additionalFeeUsdc: null,
    buyGasUsdc: null,
    netProfitUsdc: null,
    minProfitUsdc: "0",
    minProfitPct: "0",
    profitGuard: { evaluated: true, allowed: true, reason: null },
    risk: { status: "ALLOWED", reasons: [] },
    finalAction: "BUY",
    reasons: [],
    ...overrides,
  };
}

const entry = (overrides: Partial<NarrationEntry>): NarrationEntry => ({
  id: "narration:1",
  at: NOW,
  kind: "status",
  text: "テスト",
  ...overrides,
});

describe("buy celebration: the recorded side of a fill", () => {
  it("records side on trade entries and leaves the wording untouched", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor);
    let state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const d2 = runningSnapshot(db, monitor);
    d2.candidates = [candidate({})];
    state = advanceNarration(state, d2, "alive", NOW);
    const trade = state.entries.at(-1)!;
    expect(trade.kind).toBe("trade");
    expect(trade.side).toBe("BUY");
    expect(isBuyTradeEntry(trade)).toBe(true);
    expect(trade.text).toContain("PAPERで買いを記録したよ");

    const d3 = runningSnapshot(db, monitor);
    d3.candidates = [
      candidate({
        id: "cand-2",
        side: "SELL",
        finalAction: "SELL",
        timestamp: NOW + 1000,
        createdAt: NOW + 1000,
      }),
    ];
    state = advanceNarration(state, d3, "alive", NOW + 1000);
    const sell = state.entries.at(-1)!;
    expect(sell.kind).toBe("trade");
    expect(sell.side).toBe("SELL");
    expect(isBuyTradeEntry(sell)).toBe(false);
    expect(sell.text).toContain("PAPERで売りを記録したよ");
  });
});

describe("buy celebration: spotting a genuinely new buy", () => {
  it("finds a buy entry the advance added", () => {
    const prev = [entry({ id: "narration:1" })];
    const buy = entry({
      id: "narration:2",
      kind: "trade",
      side: "BUY",
      text: "PAPERで買いを記録したよ",
    });
    expect(findNewBuyEntry(prev, [...prev, buy])).toBe(buy);
  });

  it("ignores a new sell, a new non-trade and no change at all", () => {
    const prev = [entry({ id: "narration:1" })];
    const sell = entry({ id: "narration:2", kind: "trade", side: "SELL" });
    expect(findNewBuyEntry(prev, [...prev, sell])).toBeNull();
    const cycle = entry({ id: "narration:3", kind: "cycle" });
    expect(findNewBuyEntry(prev, [...prev, cycle])).toBeNull();
    expect(findNewBuyEntry(prev, prev)).toBeNull();
  });

  it("returns the newest when several buys land in one advance", () => {
    const prev: NarrationEntry[] = [];
    const first = entry({ id: "narration:1", kind: "trade", side: "BUY" });
    const second = entry({ id: "narration:2", kind: "trade", side: "BUY" });
    expect(findNewBuyEntry(prev, [first, second])).toBe(second);
  });

  it("the first advance only lays down history: it initialises the feed", () => {
    // A buy already recorded when the feed loads is seeded as
    // seen and never even becomes an entry, and the component
    // celebrates only advances after the initialising one — so
    // the loaded history can never fire a celebration.
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor);
    d.candidates = [candidate({})];
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(state.initialized).toBe(true);
    expect(state.entries.some((e) => e.kind === "trade")).toBe(false);
    expect(findNewBuyEntry([], state.entries)).toBeNull();
  });

  it("a buy landing after initialisation is spotted across two advances", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor);
    const s1 = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const d2 = runningSnapshot(db, monitor);
    d2.candidates = [
      candidate({ timestamp: NOW + 1000, createdAt: NOW + 1000 }),
    ];
    const s2 = advanceNarration(s1, d2, "alive", NOW + 1000);
    const hit = findNewBuyEntry(s1.entries, s2.entries);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe("trade");
    expect(hit!.side).toBe("BUY");
    // A sell landing the same way is never spotted.
    const d3 = runningSnapshot(db, monitor);
    d3.candidates = [
      candidate({
        id: "cand-2",
        side: "SELL",
        finalAction: "SELL",
        timestamp: NOW + 2000,
        createdAt: NOW + 2000,
      }),
    ];
    const s3 = advanceNarration(s2, d3, "alive", NOW + 2000);
    expect(findNewBuyEntry(s2.entries, s3.entries)).toBeNull();
  });

  it("wires the initialised guard and the callback into the feed", () => {
    const component = readFileSync(
      resolve("apps/dashboard/src/AgentNarration.tsx"),
      "utf8",
    );
    expect(component).toContain("if (firstAdvance || !prev.initialized) return;");
    expect(component).toContain("findNewBuyEntry(prev.entries, next.entries)");
    expect(component).toContain("CELEBRATION_FRESH_MS");
    expect(component).toContain("onCelebrate?.()");
  });
});

describe("buy celebration: the four-second window", () => {
  it("is open at the start and closed once BUY_CELEBRATION_MS passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    const startedAt = Date.now();
    expect(buyCelebrationActive(startedAt, Date.now())).toBe(true);
    vi.advanceTimersByTime(BUY_CELEBRATION_MS - 1);
    expect(buyCelebrationActive(startedAt, Date.now())).toBe(true);
    vi.advanceTimersByTime(1);
    expect(buyCelebrationActive(startedAt, Date.now())).toBe(false);
    expect(buyCelebrationActive(null, Date.now())).toBe(false);
    expect(BUY_CELEBRATION_MS).toBe(4000);
  });

  it("clears the shell's celebration on the same constant", () => {
    const main = readFileSync(resolve("apps/dashboard/src/main.tsx"), "utf8");
    expect(main).toContain("BUY_CELEBRATION_MS");
    expect(main).toContain("onCelebrate={handleBuyCelebration}");
    expect(main).toContain("celebrating={buyCelebration}");
    expect(main).toContain("glow={buyCelebration}");
  });
});

describe("buy celebration: the header avatar", () => {
  it("borrows the smile, goldens the pill and throws the burst", () => {
    const html = renderToStaticMarkup(
      <AgentHeaderAvatar pose="laptop" celebrating />,
    );
    // The smile artwork replaces the derived pose's, everywhere
    // the pose shows: class, data attribute and pill dot tone.
    expect(html).toContain('class="agent-avatar pose-pointSmile celebrating"');
    expect(html).toContain('data-pose="pointSmile"');
    expect(html).toContain("agent-white-point-smile");
    expect(html).not.toContain("agent-white-laptop");
    expect(html).toContain('class="agent-avatar-pill celebrate"');
    expect(html).toContain("買えた！");
    // The flashy burst: eight marks, five stars and three notes.
    expect(html).toContain('class="agent-avatar-burst"');
    for (const cls of ["s1", "s2", "s3", "n1", "n2", "s4", "s5", "n3"])
      expect(html).toContain(`class="${cls}"`);
    expect(html.match(/✦/g)).toHaveLength(6); // 5 burst + the pose star
    expect(html.match(/♪/g)).toHaveLength(3);
  });

  it("shows no celebration marks while not celebrating", () => {
    const html = renderToStaticMarkup(<AgentHeaderAvatar pose="laptop" />);
    expect(html).toContain('class="agent-avatar pose-laptop"');
    expect(html).not.toContain("celebrating");
    expect(html).not.toContain("agent-avatar-burst");
    expect(html).not.toContain("買えた！");
  });

  it("under reduced motion keeps the still smile and gold pill only", () => {
    (globalThis as { window?: unknown }).window = {
      matchMedia: (media: string) => ({
        matches: true,
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    };
    const html = renderToStaticMarkup(
      <AgentHeaderAvatar pose="laptop" celebrating />,
    );
    // The static distinction survives…
    expect(html).toContain("agent-white-point-smile");
    expect(html).toContain('class="agent-avatar-pill celebrate"');
    expect(html).toContain("買えた！");
    // …but no animation hook is rendered at all.
    expect(html).not.toContain("agent-avatar-burst");
    expect(html).not.toContain("celebrating");
  });
});

describe("buy celebration: feed entries", () => {
  it("marks a buy fill gold with the tag, for good", () => {
    const html = renderToStaticMarkup(
      <AgentFeedEntryRow
        entry={entry({
          kind: "trade",
          side: "BUY",
          text: "PAPERで買いを記録したよ",
        })}
      />,
    );
    expect(html).toContain('class="agent-feed-entry trade buy"');
    expect(html).toContain('class="agent-feed-entry-tag buy"');
    expect(html).toContain("買えた！");
    expect(html).not.toContain("just-bought");
  });

  it("leaves a sell fill in the plain trade look", () => {
    const html = renderToStaticMarkup(
      <AgentFeedEntryRow
        entry={entry({
          kind: "trade",
          side: "SELL",
          text: "PAPERで売りを記録したよ",
        })}
      />,
    );
    expect(html).toContain('class="agent-feed-entry trade"');
    expect(html).not.toContain("buy");
    expect(html).not.toContain("買えた！");
  });

  it("pulses only the entry that just landed", () => {
    const html = renderToStaticMarkup(
      <AgentFeedEntryRow
        entry={entry({ kind: "trade", side: "BUY" })}
        justBought
      />,
    );
    expect(html).toContain("just-bought");
  });
});

describe("buy celebration: the price ticker glow", () => {
  const frames = { 300: [], 900: [], 3600: [] } as never;

  it("carries the glow class only while celebrating", () => {
    const lit = renderToStaticMarkup(
      <PriceTicker price={0.9234} candlesByTimeframe={frames} glow />,
    );
    expect(lit).toContain('class="price-ticker glow"');
    const plain = renderToStaticMarkup(
      <PriceTicker price={0.9234} candlesByTimeframe={frames} />,
    );
    expect(plain).toContain('class="price-ticker"');
    expect(plain).not.toContain("glow");
  });
});

describe("buy celebration: the stylesheet", () => {
  const css = readFileSync(
    resolve("apps/dashboard/src/style.css"),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("frames buy entries gold with a gold tag", () => {
    expect(css).toContain(
      ".agent-feed-entry.buy {\n  border-left-color: #edc980;",
    );
    expect(css).toContain("rgba(237, 201, 128, 0.16)");
    expect(css).toContain(
      ".agent-feed-entry-tag.buy {\n  border-color: #edc980;\n  color: #edc980;\n}",
    );
  });

  it("goldens the pill and keeps every celebration motion in no-preference blocks", () => {
    expect(css).toContain(
      ".agent-avatar-pill.celebrate {\n  background: #edc980;",
    );
    const avatar = css.slice(
      css.indexOf("/* Agent header avatar:"),
      css.indexOf("/* Agent narration feed:"),
    );
    const motion = avatar.slice(
      avatar.indexOf("@media (prefers-reduced-motion: no-preference)"),
    );
    expect(motion).toContain(".agent-avatar.celebrating {");
    expect(motion).toContain("@keyframes agent-avatar-hop");
    expect(motion).toContain("@keyframes agent-avatar-burst");
    // Nothing before the avatar's motion block animates.
    expect(
      avatar.slice(
        0,
        avatar.indexOf("@media (prefers-reduced-motion: no-preference)"),
      ),
    ).not.toContain("animation:");
    // The feed pulse and the ticker glow follow the same rule.
    for (const selector of [
      ".agent-feed-entry.just-bought",
      ".price-ticker.glow",
    ]) {
      const at = css.indexOf(selector);
      expect(at).toBeGreaterThan(-1);
      const mediaAt = css.lastIndexOf(
        "@media (prefers-reduced-motion: no-preference)",
        at,
      );
      expect(mediaAt).toBeGreaterThan(-1);
      expect(css.slice(mediaAt, at)).not.toContain("@media (max-width");
    }
    expect(css).toContain("@keyframes agent-feed-buy-pulse");
    expect(css).toContain("@keyframes price-ticker-glow");
  });
});
