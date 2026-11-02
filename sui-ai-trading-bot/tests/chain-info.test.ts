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
      { epoch: 900, checkpoint: 1000, totalNetworkTransactions: 5000 },
      t0,
    );
    expect(first).toEqual({ epoch: 900, checkpoint: 1000, tps: null, at: t0 });
    const second = s.observe(
      { epoch: 900, checkpoint: 1040, totalNetworkTransactions: 5000 + 30000 },
      t0 + 30000,
    );
    // 30,000 transactions over 30 seconds.
    expect(second.tps).toBe(1000);
    expect(s.current()).toEqual(second);
  });

  it("never reports a negative TPS when the counter regresses", () => {
    const s = new ChainSampler();
    const t0 = 1_700_000_000_000;
    s.observe({ epoch: 1, checkpoint: 10, totalNetworkTransactions: 9000 }, t0);
    const next = s.observe(
      { epoch: 1, checkpoint: 20, totalNetworkTransactions: 100 },
      t0 + 30000,
    );
    expect(next.tps).toBeNull();
  });
});

describe("ChainStrip", () => {
  it("renders the chain vitals and hides itself before the first sample", () => {
    const html = renderToStaticMarkup(
      React.createElement(ChainStrip, {
        chain: { epoch: 1024, checkpoint: 182394551, tps: 1208, at: 1 },
      }),
    );
    expect(html).toContain("SUI CHAIN");
    expect(html).toContain("1,024");
    expect(html).toContain("182,394,551");
    expect(html).toContain("1,208");
    expect(
      renderToStaticMarkup(React.createElement(ChainStrip, { chain: null })),
    ).toBe("");
    const noTps = renderToStaticMarkup(
      React.createElement(ChainStrip, {
        chain: { epoch: 1, checkpoint: 5, tps: null, at: 1 },
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
