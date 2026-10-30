import { describe, expect, it } from "vitest";
import {
  agentReply,
  CHAT_CHIPS,
  followUpChips,
  proactivePrompt,
  type AgentChatContext,
} from "../apps/dashboard/src/agentChat.ts";
import type { DecisionTelemetry } from "../apps/worker/src/operations.ts";

function dec(overrides: Partial<DecisionTelemetry> = {}): DecisionTelemetry {
  const base = {
    evaluatedAt: 0,
    candleTimestamp: 0,
    action: "WAIT",
    reason: "WAIT",
    selectedRule: "none",
    sellPurpose: null,
    price: 0.93,
    entryPrice: null,
    ema20: 0.91,
    ema50: 0.92,
    rsi: 51.2,
    previousRsi: 50,
    histogram: 0.0001,
    previousHistogram: 0,
    atr: 0.02,
    volumeChange: 0,
    oversold: 45,
    overbought: 70,
    stopLossPct: 0.01,
    takeProfitPct: 0.015,
    rsiLinePrice: null,
    conditions: {
      emaUp: true,
      emaGapShrinking: false,
      rsiRecovery: true,
      histogramImproving: false,
      hasPosition: false,
      stopLoss: false,
      takeProfit: false,
    },
  } as unknown as DecisionTelemetry;
  return {
    ...base,
    ...overrides,
    conditions: { ...base.conditions, ...(overrides.conditions ?? {}) },
  } as DecisionTelemetry;
}

function ctx(overrides: Partial<AgentChatContext> = {}): AgentChatContext {
  return {
    dec: dec(),
    score: { declared: 6, hits: 3, misses: 2, inProgress: 1 },
    linePrice: null,
    running: true,
    stoppedKind: null,
    tradeCount: 0,
    recentMovePct: null,
    lastTopic: null,
    ...overrides,
  };
}

describe("agent chat replies", () => {
  it("ships the five question chips from the approved prototype", () => {
    expect(CHAT_CHIPS).toEqual([
      "なんで買わないの？",
      "あと何が足りない？",
      "調子は？",
      "ラインまでどれくらい？",
      "がんばれ",
    ]);
  });

  it("answers why-not-buying from the recorded conditions, with its topic", () => {
    const reply = agentReply("なんで買わないの？", ctx());
    expect(reply.topic).toBe("whyNotBuying");
    expect(reply.text).toContain("EMAとRSIは揃ってる");
    expect(reply.text).toContain("MACDが足りない");
    const all = agentReply(
      "なんで買わないの？",
      ctx({
        dec: dec({
          conditions: { histogramImproving: true },
        } as Partial<DecisionTelemetry>),
      }),
    );
    expect(all.text).toContain("利益保護");
    const holding = agentReply(
      "なんで買わないの？",
      ctx({
        dec: dec({
          conditions: { hasPosition: true },
        } as Partial<DecisionTelemetry>),
      }),
    );
    expect(holding.text).toContain("もう買って持ってる");
  });

  it("answers what is missing with the RSI distance", () => {
    const reply = agentReply(
      "あと何が足りない？",
      ctx({
        dec: dec({
          conditions: { rsiRecovery: false },
        } as Partial<DecisionTelemetry>),
      }),
    );
    expect(reply.text).toContain("RSI");
    expect(reply.text).toContain("あと7"); // ceil(51.2 − 45)
  });

  it("answers the score from the scoreboard", () => {
    expect(agentReply("調子は？", ctx()).text).toContain("宣言6回");
    expect(
      agentReply(
        "調子は？",
        ctx({ score: { declared: 0, hits: 0, misses: 0, inProgress: 0 } }),
      ).text,
    ).toContain("まだ宣言は出してない");
  });

  it("answers the line distance, or that no line stands", () => {
    expect(agentReply("ラインまでどれくらい？", ctx()).text).toContain(
      "立ってない",
    );
    const withLine = agentReply(
      "ラインまでどれくらい？",
      ctx({ linePrice: 0.922 }),
    );
    expect(withLine.text).toContain("$0.922");
    expect(withLine.text).toContain("−0.86%");
  });

  it("answers the sell side from the position and its lines", () => {
    expect(agentReply("利確は？", ctx()).text).toContain("まだ何も持ってない");
    const holding = agentReply(
      "利確は？",
      ctx({
        dec: dec({
          entryPrice: 0.9,
          conditions: { hasPosition: true },
        } as Partial<DecisionTelemetry>),
      }),
    );
    expect(holding.text).toContain("利確は$0.9135");
    expect(holding.text).toContain("損切りは$0.891");
  });

  it("answers PnL from the feed's trade record, never inventing a figure", () => {
    const none = agentReply("損益は？", ctx());
    expect(none.topic).toBe("pnl");
    expect(none.text).toContain("約定が1件もない");
    expect(none.text).toContain("概要タブ");
    expect(agentReply("損益は？", ctx({ tradeCount: 2 })).text).toContain(
      "約定は2件",
    );
  });

  it("answers why it stopped, per stop kind", () => {
    expect(
      agentReply("なんで止まったの？", ctx({ running: false, stoppedKind: "sleeping" })).text,
    ).toContain("手動で止まってる");
    expect(
      agentReply("なんで止まったの？", ctx({ running: false, stoppedKind: "safety" })).text,
    ).toContain("安全停止");
    expect(agentReply("止まってる？", ctx()).text).toContain("止まってないよ");
  });

  it("answers the recent price move from the recorded window", () => {
    expect(agentReply("価格はどう動いた？", ctx()).text).toContain(
      "貯まってない",
    );
    const moved = agentReply(
      "価格はどう動いた？",
      ctx({ recentMovePct: -1.234 }),
    );
    expect(moved.text).toContain("-1.23%");
    expect(moved.text).toContain("下がり気味");
    expect(moved.text).toContain("$0.93");
  });

  it("names the next highlight from lines, watches, then missing pieces", () => {
    expect(agentReply("次の見どころは？", ctx({ linePrice: 0.922 })).text).toContain(
      "買い走りライン",
    );
    expect(agentReply("次の見どころは？", ctx()).text).toContain(
      "注目してる条件",
    );
    expect(
      agentReply(
        "次の見どころは？",
        ctx({ score: { declared: 0, hits: 0, misses: 0, inProgress: 0 } }),
      ).text,
    ).toContain("MACDが揃うかどうか");
  });

  it("declines fact questions honestly when the evidence is not fresh", () => {
    expect(agentReply("なんで買わないの？", ctx({ dec: null })).text).toContain(
      "様子が掴めてない",
    );
    expect(agentReply("調子は？", ctx({ score: null })).text).toContain(
      "様子が掴めてない",
    );
  });

  it("handles sleeping greetings", () => {
    expect(
      agentReply("おはよう", ctx({ running: false, stoppedKind: "sleeping" })).text,
    ).toContain("寝てる");
  });

  it("deflects unknown questions without inventing facts, and steers back", () => {
    const reply = agentReply("明日の天気は？", ctx());
    expect(reply.topic).toBe("fallback");
    expect(reply.text).toMatch(/答えられない|分からない/);
    expect(reply.text).not.toContain("晴れ");
    expect(reply.text).toMatch(/見どころ|損益|成績|ライン/);
    expect(agentReply("明日の天気は？", ctx()).text).toBe(reply.text);
  });

  it("offers follow-up chips that continue each thread", () => {
    expect(followUpChips("whyNotBuying")).toContain("あと何が足りない？");
    expect(followUpChips("pnl")).toContain("売りラインは？");
    expect(followUpChips("fallback")).toEqual([...CHAT_CHIPS]);
    expect(followUpChips("greeting")).toEqual([...CHAT_CHIPS]);
  });

  it("routes the sell-line chip to the sell answer, not the buy line", () => {
    const reply = agentReply("売りラインは？", ctx());
    expect(reply.topic).toBe("sell");
  });

  it("continues the thread on a bare それで？", () => {
    const reply = agentReply("それで？", ctx({ lastTopic: "whyNotBuying" }));
    expect(reply.topic).toBe("missing");
    expect(reply.text).toContain("続きを言うと");
    expect(reply.text).toContain("足りないのは");
    // No thread yet: an honest deflection.
    expect(agentReply("それで？", ctx()).topic).toBe("fallback");
  });

  it("answers a bare なんで？ against the previous topic", () => {
    const reply = agentReply("なんで？", ctx({ lastTopic: "missing" }));
    expect(reply.topic).toBe("whyNotBuying");
    expect(reply.text).toContain("足りないから");
  });

  it("acknowledges a repeated question while re-answering from fresh records", () => {
    const reply = agentReply("調子は？", ctx({ lastTopic: "score" }));
    expect(reply.topic).toBe("score");
    expect(reply.text).toContain("さっきも言ったけど");
    expect(reply.text).toContain("宣言6回");
    // Social topics never get the repeat prefix.
    expect(agentReply("がんばれ", ctx({ lastTopic: "encouragement" })).text).not.toContain(
      "さっきも言ったけど",
    );
  });

  it("speaks up at milestones with the natural follow-up chip", () => {
    expect(proactivePrompt({ kind: "priceLine" })?.chip).toBe(
      "ラインまでどれくらい？",
    );
    expect(proactivePrompt({ kind: "watchHit" })?.chip).toBe("調子は？");
    expect(proactivePrompt({ kind: "nearMiss" })?.chip).toBe(
      "あと何が足りない？",
    );
    expect(proactivePrompt({ kind: "alert" })?.chip).toBe("価格はどう動いた？");
    expect(proactivePrompt({ kind: "trade", side: "BUY" })?.chip).toBe(
      "売りラインは？",
    );
    expect(proactivePrompt({ kind: "trade", side: "SELL" })).toBeNull();
    expect(proactivePrompt({ kind: "cycle" })).toBeNull();
  });
});
