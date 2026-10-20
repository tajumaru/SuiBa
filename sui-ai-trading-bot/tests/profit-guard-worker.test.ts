import { it, expect, vi } from "vitest";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { initialPortfolio } from "../packages/paper-trading/src/index.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import { USDC } from "../packages/shared/src/index.ts";
import {
  defaults,
  type Candle,
  type DexRouter,
} from "../packages/shared/src/index.ts";
function setup(basis: number, gasUnknown = false) {
  const db = new BotDatabase(":memory:");
  db.set("runtime", {
    running: true,
    emergency: false,
    error: null,
    lastCandle: null,
  });
  db.set("portfolio", { ...initialPortfolio(), sui: 1, costBasis: basis });
  db.updateSettings({
    ...defaults,
    minNetProfitUsdc: 0.1,
  });
  const closed = Math.floor(Date.now() / 300000) * 300 - 300,
    c: Candle[] = Array.from({ length: 70 }, (_, i) => ({
      timestamp: closed - (69 - i) * 300,
      open: 2,
      high: 2.1,
      low: 1.9,
      close: 2,
      volume: 10000,
      timeframe: 300,
      source: "mock",
    }));
  const getQuote = vi.fn<DexRouter["getQuote"]>(async (r) => {
    if (gasUnknown) throw new Error("quote unavailable");
    const now = Date.now();
    return {
      ...r,
      id: "mock",
      amountOut: "2000000",
      minAmountOut: "1994000",
      priceImpact: 0,
      liquid: true,
      route: ["CETUS"],
      createdAt: now,
      expiresAt: now + 15000,
      source: "mock",
    };
  });
  const engine = new BotEngine(
    db,
    { candles: async () => c },
    { getQuote, validateQuote: async () => true },
    {
      health: async () => ({
        healthy: true,
        checkedAt: Date.now(),
        failures: 0,
      }),
      status: { healthy: true, checkedAt: Date.now(), failures: 0 },
    },
  );
  return { db, engine, getQuote };
}
it("keeps the raw SELL decision but persists an effective WAIT when take-profit is below its net-profit threshold", async () => {
  const t = setup(1.9);
  await t.engine.tick();
  expect(t.db.history("paper_trades")).toHaveLength(0);
  expect(t.db.get<{ action: string }>("decision")?.action).toBe("WAIT");
  expect(t.db.history<{ action: string }>("strategy_decisions")[0].action).toBe(
    "SELL",
  );
  expect(t.db.history("profit_assessments")).not.toHaveLength(0);
  t.db.close();
});
it("executes stop-loss at a loss without a ProfitGuard veto, still through RiskEngine", async () => {
  const t = setup(3);
  await t.engine.tick();
  expect(t.db.history<{ pnl: number }>("paper_trades")[0].pnl).toBeLessThan(0);
  expect(t.db.get<{ reason: string }>("profitGuard")?.reason).toBe(
    "PROTECTIVE_EXIT_PROFIT_BYPASS",
  );
  t.db.close();
});
it("does not execute a protective exit without a usable quote", async () => {
  const t = setup(3, true);
  await t.engine.tick();
  expect(t.db.history("paper_trades")).toHaveLength(0);
  expect(t.db.runtime().running).toBe(false);
  t.db.close();
});
it("restores old settings with ProfitGuard defaults and does not pretend legacy fee details are known", () => {
  const t = setup(1.9);
  const { profitGuardEnabled, minNetProfitUsdc, minNetProfitPct, ...legacy } =
    defaults;
  t.db.set("settings", legacy);
  expect(t.db.settings().profitGuardEnabled).toBe(true);
  expect(t.db.settings().minNetProfitUsdc).toBe(0.05);
  expect(t.db.settings().minNetProfitPct).toBe(0.01);
  expect(t.engine.snapshot().acquisitionFees).toBeNull();
  t.db.close();
});
it.each(["allowed", "missing-reverse", "emergency"] as const)(
  "BUY obtains a reverse quote and handles %s safely",
  async (mode) => {
    const t = setup(0);
    t.db.set("portfolio", initialPortfolio());
    t.db.updateSettings({
      ...defaults,
      takeProfitPct: 0.3,
      minNetProfitUsdc: 0.05,
    });
    const spy = vi
      .spyOn(RuleBasedStrategy.prototype, "analyze")
      .mockResolvedValue({
        action: "BUY",
        confidence: 0.7,
        reason: "mock BUY",
        stopLossPct: 0.02,
        takeProfitPct: 0.3,
        timestamp: new Date().toISOString(),
      });
    t.getQuote.mockImplementation(async (r) => {
      if (r.from !== USDC) {
        if (mode === "missing-reverse") throw new Error("mock missing");
        if (mode === "emergency")
          t.db.set("runtime", {
            ...t.db.runtime(),
            running: false,
            emergency: true,
          });
      }
      const now = Date.now();
      return {
        ...r,
        id: "mock",
        amountOut: r.from === USDC ? "2500000000" : "4950000",
        minAmountOut: r.from === USDC ? "2492500000" : "4935150",
        priceImpact: 0,
        liquid: true,
        route: ["CETUS"],
        createdAt: now,
        expiresAt: now + 15000,
        source: "mock",
      };
    });
    try {
      await t.engine.tick();
      expect(t.getQuote).toHaveBeenCalledTimes(2);
      expect(t.db.history("paper_trades")).toHaveLength(
        mode === "allowed" ? 1 : 0,
      );
      if (mode === "missing-reverse") {
        expect(t.db.get<{ action: string }>("decision")?.action).toBe("WAIT");
        expect(t.db.runtime().running).toBe(true);
      }
      if (mode === "emergency") expect(t.db.runtime().emergency).toBe(true);
    } finally {
      spy.mockRestore();
      t.db.close();
    }
  },
);
