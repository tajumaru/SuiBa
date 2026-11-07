import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { auditDatabase } from "../scripts/ml-data-audit.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  data: Record<
    string,
    { id: string; at: number; value: unknown; raw?: string }[]
  >,
) {
  const root = mkdtempSync(join(tmpdir(), "suiba-ml-audit-"));
  roots.push(root);
  const file = join(root, "snapshot.sqlite");
  const db = new DatabaseSync(file);
  try {
    for (const [table, rows] of Object.entries(data)) {
      db.exec(
        `CREATE TABLE ${table}(id TEXT PRIMARY KEY,timestamp INTEGER,json TEXT)`,
      );
      const insert = db.prepare(`INSERT INTO ${table} VALUES(?,?,?)`);
      for (const r of rows)
        insert.run(r.id, r.at, r.raw ?? JSON.stringify(r.value));
    }
  } finally {
    db.close();
  }
  return file;
}
const window = { from: 1000, until: 5000 };
it("counts only complete versioned evidence available by the recorded decision time", () => {
  const current = Object.fromEntries(
    [
      "ema20",
      "ema50",
      "rsi",
      "macd",
      "signal",
      "histogram",
      "atr",
      "volumeChange",
      "priceChange",
    ].map((k) => [k, 1]),
  );
  const evidence = {
    version: 1,
    inputs: {
      current,
      previous: current,
      price: 1,
      latestVolume: 2,
      previousVolume: 1,
      entryPrice: null,
    },
    candleTimestamp: 300,
    previousCandleTimestamp: 0,
    evaluatedAt: 610000,
    selectedRule: "BUY_SIGNAL",
    conditions: { emaUp: true },
    thresholds: {
      oversold: 30,
      overbought: 70,
      maxVolumeChange: 1,
      stopLossPct: 0.01,
      takeProfitPct: 0.02,
    },
  };
  const file = fixture({
    strategy_decisions: [
      { id: "valid", at: 610000, value: { action: "BUY", evidence } },
      {
        id: "late-input",
        at: 610001,
        value: {
          action: "BUY",
          evidence: { ...evidence, evaluatedAt: 700000 },
        },
      },
      {
        id: "open-candle",
        at: 610002,
        value: {
          action: "BUY",
          evidence: { ...evidence, candleTimestamp: 600 },
        },
      },
    ],
  });
  const r = auditDatabase(file, { from: 600000, until: 700000 });
  expect(r.decisionCoverage.evidenceComplete).toBe(1);
  expect(r.decisionCoverage.closedAtDecision).toBe(2);
  expect(r.blockers).toContain("INCOMPLETE_DECISION_EVIDENCE");
});
it("audits without migrating legacy databases or changing the database bytes", () => {
  const file = fixture({
    strategy_decisions: [{ id: "old", at: 1000, value: { action: "WAIT" } }],
  });
  const before = readFileSync(file);
  const r = auditDatabase(file, window);
  expect(readFileSync(file)).toEqual(before);
  expect(r.missingTables).toContain("cycle_audits");
  expect(r.decisionCoverage.actions.WAIT).toBe(1);
  expect(r.decisionCoverage.evidenceComplete).toBe(0);
  expect(r.trainingReady).toBe(false);
  expect(r.baseline.fullRunNetPnlUsdc).toBeNull();
});
it("does not create a missing input and rejects empty or reversed windows", () => {
  const file = fixture({});
  const missing = join(file, "missing.sqlite");
  expect(() => auditDatabase(missing, window)).toThrow();
  expect(existsSync(missing)).toBe(false);
  expect(() => auditDatabase(file, { from: 2, until: 2 })).toThrow(
    "INVALID_AUDIT_WINDOW",
  );
  expect(() => auditDatabase(file, { from: 5, until: 4 })).toThrow(
    "INVALID_AUDIT_WINDOW",
  );
});
it("uses half-open windows and joins by explicit identifiers, never timestamp proximity", () => {
  const file = fixture({
    strategy_decisions: [
      { id: "cycle", at: 1000, value: { action: "BUY" } },
      { id: "outside", at: 5000, value: { action: "SELL" } },
    ],
    operation_candidates: [
      { id: "candidate", at: 1500, value: { orderId: "order" } },
    ],
    cycle_audits: [
      {
        id: "end",
        at: 2000,
        value: { phase: "END", cycleId: "cycle", candidateId: "candidate" },
      },
    ],
    paper_orders: [{ id: "order", at: 2100, value: {} }],
    paper_trades: [
      {
        id: "order",
        at: 2100,
        value: { orderId: "order", side: "BUY", fee: 0.1 },
      },
      { id: "unlinked", at: 2100, value: { side: "BUY", fee: 0.2 } },
    ],
  });
  const r = auditDatabase(file, window);
  expect(r.decisionCoverage.rows).toBe(1);
  expect(r.decisionCoverage.candidatesLinkedThroughCycleEnd).toBe(1);
  expect(r.decisionCoverage.tradesJoinedToOrder).toBe(1);
  expect(r.decisionCoverage.tradesJoinedToCandidate).toBe(1);
});
it("reports allocated SELL profits without subtracting fees twice and includes zero equity", () => {
  const file = fixture({
    paper_trades: [
      { id: "buy", at: 1000, value: { side: "BUY", fee: 0.1 } },
      {
        id: "sell",
        at: 2000,
        value: { side: "SELL", realizedProfitUsdc: "1.25", fee: 0.2 },
      },
      {
        id: "partial",
        at: 3000,
        value: { side: "SELL", realizedProfitUsdc: "-0.25", fee: 0.3 },
      },
    ],
    portfolio_snapshots: [100, 110, 88, 0].map((equity, i) => ({
      id: String(i),
      at: 1000 + i * 1000,
      value: { equity },
    })),
  });
  const b = auditDatabase(file, window).baseline;
  expect(b.realizedPnlOnWindowSellsUsdc).toBe("1");
  expect(b.additionalFeesAndGasUsdc).toBe("0.6");
  expect(b.sellFillWinRate).toBe(0.5);
  expect(b.observedEquityChangeUsdc).toBe("-100");
  expect(b.sampledMaxDrawdownPct).toBe(100);
  expect(b.fullRunNetPnlUsdc).toBeNull();
});
it("keeps missing costs and malformed outcomes unknown rather than assuming zero", () => {
  const file = fixture({
    paper_trades: [
      { id: "missing", at: 1000, value: { side: "SELL" } },
      { id: "bad", at: 2000, value: {}, raw: "{broken" },
    ],
  });
  const r = auditDatabase(file, window);
  expect(r.inventory.paper_trades.malformed).toBe(1);
  expect(r.baseline.rawTradeRows).toBe(2);
  expect(r.baseline.realizedPnlOnWindowSellsUsdc).toBeNull();
  expect(r.baseline.additionalFeesAndGasUsdc).toBeNull();
  expect(r.baseline.sellFillWinRate).toBeNull();
  expect(r.blockers).toContain("MALFORMED_JSON_ROWS");
});
it("distinguishes repeated polling BUY signals from independent candle opportunities", () => {
  const inputs = {
    current: Object.fromEntries(
      [
        "ema20",
        "ema50",
        "rsi",
        "macd",
        "signal",
        "histogram",
        "atr",
        "volumeChange",
        "priceChange",
      ].map((k) => [k, 1]),
    ),
    price: 1,
  };
  const file = fixture({
    strategy_decisions: [0, 1].map((i) => ({
      id: String(i),
      at: 400000 + i,
      value: {
        action: "BUY",
        evidence: {
          inputs: { ...inputs, previous: inputs.current },
          candleTimestamp: 0,
          evaluatedAt: 400000,
          selectedRule: "BUY_SIGNAL",
          thresholds: {},
          conditions: {},
        },
      },
    })),
  });
  const r = auditDatabase(file, { from: 0, until: 500000 });
  expect(r.decisionCoverage.uniqueBuySignalsWithCandleEvidence).toBe(1);
  expect(r.decisionCoverage.duplicateBuySignals).toBe(1);
  expect(r.decisionCoverage.closedAtDecision).toBe(2);
});
