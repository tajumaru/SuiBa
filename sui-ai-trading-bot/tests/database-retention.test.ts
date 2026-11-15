import { expect, it } from "vitest";
import {
  BotDatabase,
  RETENTION_CHUNK_ROWS,
  RETENTION_FULL_EVIDENCE_DAYS,
} from "../packages/database/src/index.ts";

const day = 24 * 60 * 60 * 1000;
const now = 2_000_000_000_000;
type RetainedDecision = Record<string, unknown> & {
  _retention?: number;
  evidence?: { inputs: Record<string, unknown> };
};
const decision = {
  action: "BUY",
  confidence: 0.8,
  reason: "large free-text explanation",
  stopLossPct: 0.01,
  takeProfitPct: 0.02,
  timestamp: new Date(now).toISOString(),
  analysisContext: { cycleId: "cycle", runningAtStart: true },
  evidence: {
    version: 1,
    evaluatedAt: now,
    candleTimestamp: 100,
    previousCandleTimestamp: 99,
    inputs: {
      price: 3.25,
      entryPrice: 3,
      latestVolume: 20,
      previousVolume: 10,
      current: { rsi: 40, ema20: 3.2 },
      previous: { rsi: 39, ema20: 3.1 },
    },
    thresholds: { oversold: 30 },
    conditions: { emaUp: true, rsiRecovery: false },
    selectedRule: "BUY_SIGNAL",
  },
};

it("compacts only rows older than 30 days and never changes row counts", () => {
  const db = new BotDatabase(":memory:");
  const cutoff = now - RETENTION_FULL_EVIDENCE_DAYS * day;
  db.append("strategy_decisions", "old", decision, cutoff - 1);
  db.append("strategy_decisions", "boundary", decision, cutoff);
  db.append(
    "cycle_audits",
    "audit-old",
    {
      cycleId: "old",
      phase: "END",
      outcome: "ANALYZED",
      candidateId: "candidate",
      orderId: "order",
      analysis: { bulky: "discarded" },
    },
    cutoff - 1,
  );
  db.append("cycle_audits", "audit-boundary", { phase: "END" }, cutoff);

  expect(db.maintainRetentionChunk(now)).toBe(2);
  expect(db.history("strategy_decisions")).toHaveLength(2);
  expect(db.history("cycle_audits")).toHaveLength(2);
  const decisions = db.history<RetainedDecision>("strategy_decisions");
  const compact = decisions.find((row) => row._retention === 1)!;
  expect(compact).toMatchObject({
    action: "BUY",
    confidence: 0.8,
    evidence: {
      candleTimestamp: 100,
      inputs: { price: 3.25, entryPrice: 3 },
      conditions: { emaUp: true, rsiRecovery: false },
      selectedRule: "BUY_SIGNAL",
    },
  });
  expect(compact.reason).toBeUndefined();
  expect(compact.evidence?.inputs.current).toBeUndefined();
  expect(decisions.find((row) => row._retention === undefined)).toEqual(
    decision,
  );
  expect(db.history<Record<string, unknown>>("cycle_audits")).toContainEqual({
    _retention: 1,
    cycleId: "old",
    phase: "END",
    outcome: "ANALYZED",
    candidateId: "candidate",
    orderId: "order",
  });
  db.close();
});

it("does bounded work and eventually compacts every old row", () => {
  const db = new BotDatabase(":memory:");
  const total = RETENTION_CHUNK_ROWS + 3;
  for (let i = 0; i < total; i++) {
    db.append("strategy_decisions", `decision-${i}`, decision, now - 31 * day);
    db.append(
      "cycle_audits",
      `audit-${i}`,
      { cycleId: String(i), phase: "END" },
      now - 31 * day,
    );
  }
  expect(db.maintainRetentionChunk(now)).toBe(RETENTION_CHUNK_ROWS * 2);
  expect(
    db
      .history<RetainedDecision>("strategy_decisions", total)
      .filter((r) => r._retention === 1),
  ).toHaveLength(RETENTION_CHUNK_ROWS);
  expect(db.maintainRetentionChunk(now)).toBe(6);
  expect(db.maintainRetentionChunk(now)).toBe(0);
  expect(db.history("strategy_decisions", total)).toHaveLength(total);
  expect(db.history("cycle_audits", total)).toHaveLength(total);
  db.close();
});
