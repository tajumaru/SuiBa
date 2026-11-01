import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  commandSuggestions,
  isCommandText,
  runChatCommand,
} from "../apps/dashboard/src/chatCommands.ts";
import type { AgentChatContext } from "../apps/dashboard/src/agentChat.ts";
import { AgentFeedEntryRow } from "../apps/dashboard/src/AgentNarration.tsx";
import type { NarrationEntry } from "../apps/dashboard/src/agentNarration.ts";

const ctx = (over: Partial<AgentChatContext> = {}): AgentChatContext =>
  ({
    dec: null,
    score: null,
    linePrice: null,
    running: true,
    stoppedKind: null,
    tradeCount: 2,
    recentMovePct: null,
    lastTopic: null,
    exchangeCount: 0,
    pairLabel: "SUI",
    ...over,
  }) as AgentChatContext;

const dec = {
  price: 0.8972,
  rsi: 41.3,
  oversold: 45,
  conditions: {
    emaUp: true,
    emaGapShrinking: false,
    rsiRecovery: false,
    histogramImproving: true,
    hasPosition: false,
  },
} as AgentChatContext["dec"];

describe("chat commands", () => {
  it("detects and suggests commands by prefix", () => {
    expect(isCommandText("/score")).toBe(true);
    expect(isCommandText("  /status")).toBe(true);
    expect(isCommandText("調子は？")).toBe(false);
    expect(commandSuggestions("/").map((c) => c.name)).toContain("/score");
    expect(commandSuggestions("/s").map((c) => c.name)).toEqual([
      "/status",
      "/score",
    ]);
    expect(commandSuggestions("/x")).toEqual([]);
  });

  it("/status reads the recorded state", () => {
    const out = runChatCommand("/status", ctx({ dec }));
    expect(out).toContain("運用中");
    expect(out).toContain("SUI / USDC");
    expect(out).toContain("$0.8972");
    expect(out).toContain("EMA ok / RSI -- / MACD ok");
    expect(out).toContain("2 件");
    const stopped = runChatCommand(
      "/status",
      ctx({ running: false, stoppedKind: "safety" }),
    );
    expect(stopped).toContain("安全停止中");
    expect(stopped).toContain("確認中");
  });

  it("/score summarises the scoreboard or declines", () => {
    const out = runChatCommand(
      "/score",
      ctx({
        score: { declared: 7, inProgress: 1, hits: 4, misses: 2 },
      }),
    );
    expect(out).toContain("declared");
    expect(out).toContain("hit-rate");
    expect(out).toContain("67%");
    expect(runChatCommand("/score", ctx())).toContain("まだ集計なし");
  });

  it("/line reports the standing buy-run line and the gap", () => {
    const out = runChatCommand("/line", ctx({ dec, linePrice: 0.8806 }));
    expect(out).toContain("$0.8806");
    expect(out).toContain("あと 1.89% 下がると到達");
    const none = runChatCommand("/line", ctx({ dec }));
    expect(none).toContain("立っていない");
  });

  it("/ping, /help and unknown commands", () => {
    expect(runChatCommand("/ping", ctx())).toBe("pong");
    const help = runChatCommand("/help", ctx());
    expect(help).toContain("/status");
    expect(help).toContain("/score");
    const unknown = runChatCommand("/xyz", ctx());
    expect(unknown).toContain("unknown command: /xyz");
    expect(unknown).toContain("/help");
    // Case and surrounding space do not matter.
    expect(runChatCommand(" /PING ", ctx())).toBe("pong");
  });

  it("a command reply renders as a CMD monospace entry", () => {
    const entry: NarrationEntry = {
      id: "narration:9",
      at: 1_700_000_000_000,
      kind: "chatReply",
      text: "status ... 運用中\npair ..... SUI / USDC",
      mono: true,
    };
    const html = renderToStaticMarkup(
      React.createElement(AgentFeedEntryRow, { entry }),
    );
    expect(html).toContain("CMD");
    expect(html).toContain("mono");
    const plain: NarrationEntry = { ...entry, mono: undefined };
    const plainHtml = renderToStaticMarkup(
      React.createElement(AgentFeedEntryRow, { entry: plain }),
    );
    expect(plainHtml).toContain("返信");
    expect(plainHtml).not.toContain("CMD");
  });
});
