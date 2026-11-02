import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChainSampler } from "../apps/worker/src/chainInfo.ts";
import { ChainStrip } from "../apps/dashboard/src/ChainStrip.tsx";
import { runChatCommand } from "../apps/dashboard/src/chatCommands.ts";
import type { AgentChatContext } from "../apps/dashboard/src/agentChat.ts";

describe("ChainSampler", () => {
  it("reports epoch/checkpoint immediately and TPS only after a 20s window", () => {
    const s = new ChainSampler();
    const t0 = 1_700_000_000_000;
    const first = s.observe(
      { epoch: 900, checkpoint: 1000, totalNetworkTransactions: 5000, gasMist: 1000 },
      t0,
    );
    expect(first).toEqual({ epoch: 900, checkpoint: 1000, tps: null, gasMist: 1000, at: t0 });
    const second = s.observe(
      { epoch: 900, checkpoint: 1040, totalNetworkTransactions: 5000 + 30000, gasMist: 1000 },
      t0 + 30000,
    );
    // 30,000 transactions over 30 seconds.
    expect(second.tps).toBe(1000);
    expect(s.current()).toEqual(second);
  });

  it("never reports a negative TPS when the counter regresses", () => {
    const s = new ChainSampler();
    const t0 = 1_700_000_000_000;
    s.observe({ epoch: 1, checkpoint: 10, totalNetworkTransactions: 9000, gasMist: null }, t0);
    const next = s.observe(
      { epoch: 1, checkpoint: 20, totalNetworkTransactions: 100, gasMist: null },
      t0 + 30000,
    );
    expect(next.tps).toBeNull();
  });
});

describe("ChainStrip", () => {
  it("renders the chain vitals and hides itself before the first sample", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChainStrip, {
        chain: { epoch: 1024, checkpoint: 182394551, tps: 1208, gasMist: 1000, at: 1 },
      }),
    );
    expect(html).toContain("SUI CHAIN");
    expect(html).toContain("1,024");
    expect(html).toContain("182,394,551");
    expect(html).toContain("1,208");
    expect(html).toContain("GAS");
    expect(html).toContain("1,000 MIST");
    expect(
      renderToStaticMarkup(React.createElement(ChainStrip, { chain: null })),
    ).toBe("");
    const noTps = renderToStaticMarkup(
      React.createElement(ChainStrip, {
        chain: { epoch: 1, checkpoint: 5, tps: null, gasMist: null, at: 1 },
      }),
    );
    expect(noTps).toContain("—");
  });
});

describe("/status chain row", () => {
  const base: AgentChatContext = {
    dec: null,
    score: null,
    linePrice: null,
    running: true,
    stoppedKind: null,
    tradeCount: 0,
    recentMovePct: null,
    lastTopic: null,
    exchangeCount: 0,
    pairLabel: "SUI",
    chain: null,
  };
  it("includes the chain row only when a sample exists", () => {
    expect(runChatCommand("/status", base)).not.toContain("chain");
    const withChain = runChatCommand("/status", {
      ...base,
      chain: { epoch: 1024, checkpoint: 182394551, tps: 1208 },
    });
    expect(withChain).toContain("EPOCH 1024");
    expect(withChain).toContain("CKP 182,394,551");
    expect(withChain).toContain("TPS 1208");
  });
});

describe("epoch marks", () => {
  it("announces only a witnessed boundary", async () => {
    const { epochTransition, loadLastEpoch, saveLastEpoch } = await import(
      "../apps/dashboard/src/epochMark.ts"
    );
    expect(epochTransition(null, 1300)).toBeNull();
    expect(epochTransition(1300, 1300)).toBeNull();
    expect(epochTransition(1300, 1301)).toBe(1301);
    expect(epochTransition(1301, 1300)).toBeNull();
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadLastEpoch(storage)).toBeNull();
    saveLastEpoch(1301, storage);
    expect(loadLastEpoch(storage)).toBe(1301);
  });

  it("keeps the last known gas price when a sample's gas read failed", () => {
    const s = new ChainSampler();
    const t0 = 1_700_000_000_000;
    s.observe(
      { epoch: 1, checkpoint: 10, totalNetworkTransactions: 100, gasMist: 750 },
      t0,
    );
    const next = s.observe(
      { epoch: 1, checkpoint: 20, totalNetworkTransactions: 200, gasMist: null },
      t0 + 15000,
    );
    expect(next.gasMist).toBe(750);
  });
});
