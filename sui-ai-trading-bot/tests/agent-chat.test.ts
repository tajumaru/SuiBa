import { describe, expect, it } from "vitest";
import {
  agentReply,
  CHAT_CHIPS,
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
    sleeping: false,
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

  it("answers why-not-buying from the recorded conditions", () => {
    const reply = agentReply("なんで買わないの？", ctx());
    expect(reply).toContain("EMAとRSIは揃ってる");
    expect(reply).toContain("MACDが足りない");
    // Everything met: the gate left is the profit guard.
    const all = agentReply(
      "なんで買わないの？",
      ctx({
        dec: dec({
          conditions: { histogramImproving: true },
        } as Partial<DecisionTelemetry>),
      }),
    );
    expect(all).toContain("利益保護");
    // Holding: no longer a buy question.
    const holding = agentReply(
      "なんで買わないの？",
      ctx({
        dec: dec({
          conditions: { hasPosition: true },
        } as Partial<DecisionTelemetry>),
      }),
    );
    expect(holding).toContain("もう買って持ってる");
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
    expect(reply).toContain("RSI");
    expect(reply).toContain("あと7"); // ceil(51.2 − 45)
  });

  it("answers the score from the scoreboard", () => {
    expect(agentReply("調子は？", ctx())).toContain("宣言6回");
    expect(
      agentReply("調子は？", ctx({ score: { declared: 0, hits: 0, misses: 0, inProgress: 0 } })),
    ).toContain("まだ宣言は出してない");
  });

  it("answers the line distance, or that no line stands", () => {
    expect(agentReply("ラインまでどれくらい？", ctx())).toContain(
      "立ってない",
    );
    const withLine = agentReply(
      "ラインまでどれくらい？",
      ctx({ linePrice: 0.922 }),
    );
    expect(withLine).toContain("$0.922");
    expect(withLine).toContain("−0.86%");
  });

  it("answers the sell side from the position and its lines", () => {
    expect(agentReply("利確は？", ctx())).toContain("まだ何も持ってない");
    const holding = agentReply(
      "利確は？",
      ctx({
        dec: dec({
          entryPrice: 0.9,
          conditions: { hasPosition: true },
        } as Partial<DecisionTelemetry>),
      }),
    );
    expect(holding).toContain("利確は$0.9135");
    expect(holding).toContain("損切りは$0.891");
  });

  it("declines fact questions honestly when the evidence is not fresh", () => {
    expect(agentReply("なんで買わないの？", ctx({ dec: null }))).toContain(
      "様子が掴めてない",
    );
    expect(agentReply("調子は？", ctx({ score: null }))).toContain(
      "様子が掴めてない",
    );
  });

  it("handles stopped and sleeping states before conditions", () => {
    expect(agentReply("なんで買わないの？", ctx({ running: false }))).toContain(
      "止まってる",
    );
    expect(
      agentReply("おはよう", ctx({ running: false, sleeping: true })),
    ).toContain("寝てる");
  });

  it("deflects unknown questions without inventing facts", () => {
    const reply = agentReply("明日の天気は？", ctx());
    expect(reply).toMatch(/答えられない|分からない/);
    expect(reply).not.toContain("晴れ");
    // Same input always gets the same fallback (hash-stable).
    expect(agentReply("明日の天気は？", ctx())).toBe(reply);
  });
});
