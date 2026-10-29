import { afterEach, describe, it, expect, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import {
  PaperTrading,
  initialPortfolio,
  type Fill,
} from "../packages/paper-trading/src/index.ts";
import {
  reconcileFill,
  accountingTolerance,
} from "../packages/paper-trading/src/reconciliation.ts";
import { RuleBasedStrategy } from "../packages/strategy-engine/src/index.ts";
import {
  atomic,
  units,
  SUI,
  USDC,
  defaults,
  type Candle,
  type DexRouter,
  type QuoteResult,
} from "../packages/shared/src/index.ts";
import type { CandidateAudit } from "../packages/shared/src/operations.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const now = Date.now();
function candles(): Candle[] {
  const last = Math.floor(Date.now() / 300000) * 300 - 300;
  return Array.from({ length: 70 }, (_, i) => ({
    timestamp: last - (69 - i) * 300,
    open: 2,
    high: 2.1,
    low: 1.9,
    close: 2,
    volume: 10000,
    timeframe: 300,
    source: "test",
  }));
}
function quote(
  side: "BUY" | "SELL",
  input: string,
  stamp = Date.now(),
): QuoteResult {
  return {
    from: side === "BUY" ? USDC : SUI,
    to: side === "BUY" ? SUI : USDC,
    amountIn: input,
    amountOut: atomic(
      side === "BUY" ? units(input, USDC) / 2 : units(input, SUI) * 2,
      side === "BUY" ? SUI : USDC,
    ),
    minAmountOut: atomic(
      side === "BUY"
        ? (units(input, USDC) / 2) * 0.997
        : units(input, SUI) * 2 * 0.997,
      side === "BUY" ? SUI : USDC,
    ),
    id: "test",
    slippage: 0.003,
    referencePrice: 2,
    priceImpact: 0,
    liquid: true,
    route: ["test"],
    createdAt: stamp,
    expiresAt: stamp + 15000,
    source: "test",
    dexFeeUsdc: null,
  };
}
function setup(action: "BUY" | "SELL" | "WAIT" = "BUY") {
  const db = new BotDatabase(":memory:");
  db.set("runtime", { ...db.runtime(), running: true });
  db.updateSettings({ ...defaults, takeProfitPct: 0.3 });
  if (action === "SELL")
    db.set("portfolio", { ...db.portfolio(), sui: 1, costBasis: 3 });
  vi.spyOn(RuleBasedStrategy.prototype, "analyze").mockResolvedValue({
    action,
    confidence: 1,
    reason: "test",
    stopLossPct: 0.02,
    takeProfitPct: 0.3,
    timestamp: new Date().toISOString(),
    ...(action === "SELL" ? { sellPurpose: "STOP_LOSS" as const } : {}),
  });
  const router: DexRouter = {
    getQuote: vi.fn(async (request) => ({
      ...quote(request.from === USDC ? "BUY" : "SELL", request.amountIn),
      ...request,
    })),
    validateQuote: async () => true,
  };
  const market = { candles: vi.fn(async () => candles()) };
  const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(db, market, router, {
    health: async () => health,
    status: health,
  });
  return { db, engine, router, market };
}
afterEach(() => vi.restoreAllMocks());

describe("PAPER operation monitor", () => {
  it("records fresh market data and WAIT once per closed candle with no fictitious orders", async () => {
    const t = setup("WAIT");
    await t.engine.tick();
    await t.engine.tick();
    const s = t.engine.monitor.snapshot();
    expect(s.status).toBe("RUNNING");
    expect(s.lastMarketAt).not.toBeNull();
    expect(s.lastHealthyAt).not.toBeNull();
    expect(s.actions.waits).toBe(1);
    expect(s.lastQuoteAt).toBeNull();
    expect(t.db.history("paper_trades")).toHaveLength(0);
    t.db.close();
  });
  it("rejects stale market data before any candidate or fill", async () => {
    const t = setup();
    t.market.candles.mockResolvedValue(
      candles().map((c) => ({ ...c, timestamp: c.timestamp - 900 })),
    );
    await t.engine.tick();
    expect(t.db.runtime()).toMatchObject({
      running: false,
      error: "STALE_CANDLES",
    });
    expect(t.db.history("paper_trades")).toHaveLength(0);
    expect(t.engine.monitor.snapshot().status).toBe("ABNORMAL_STOP");
    t.db.close();
  });
  it("records a Profit Guard rejection once, without counting display previews or claiming RiskEngine ran", async () => {
    const t = setup("SELL");
    t.db.set("portfolio", { ...t.db.portfolio(), costBasis: 1.97 });
    vi.spyOn(RuleBasedStrategy.prototype, "analyze").mockResolvedValue({
      action: "SELL",
      confidence: 1,
      reason: "take profit",
      stopLossPct: 0.02,
      takeProfitPct: 0.04,
      timestamp: "",
      sellPurpose: "TAKE_PROFIT",
    });
    await t.engine.tick();
    await t.engine.tick();
    const s = t.engine.monitor.snapshot();
    expect(s.actions.profitRejected).toBe(1);
    expect(s.actions.riskRejected).toBe(0);
    expect(s.candidates[0]).toMatchObject({
      finalAction: "WAIT",
      risk: { status: "NOT_EVALUATED" },
      profitGuard: { evaluated: true, allowed: false },
    });
    expect(t.db.history("profit_assessments").length).toBeGreaterThan(1);
    t.db.close();
  });
  it("records an expired protective quote and does not waive quote safety", async () => {
    const t = setup("SELL");
    vi.mocked(t.router.getQuote).mockImplementation(async (request) => ({
      ...quote("SELL", request.amountIn, Date.now() - 20000),
      ...request,
    }));
    await t.engine.tick();
    const s = t.engine.monitor.snapshot();
    expect(s.candidates[0].profitGuard.reason).toBe("QUOTE_EXPIRED");
    expect(s.actions.profitRejected).toBe(1);
    expect(t.db.history("paper_trades")).toHaveLength(0);
    expect(s.events.some((e) => e.code === "QUOTE_EXPIRED")).toBe(true);
    t.db.close();
  });
  it("records RiskEngine refusal separately and preserves daily loss protection without blocking protective exits", async () => {
    const t = setup();
    t.db.set("portfolio", { ...t.db.portfolio(), dayStartEquity: 110 });
    await t.engine.tick();
    const s = t.engine.monitor.snapshot();
    expect(s.actions.riskRejected).toBe(1);
    expect(s.candidates[0].risk.reasons).toContain("DAILY_LOSS_LIMIT");
    expect(s.actions.profitRejected).toBe(0);
    expect(s.events.some((e) => e.code === "DAILY_LOSS_LIMIT")).toBe(true);
    expect(t.db.history("paper_trades")).toHaveLength(0);
    t.db.close();
  });
  it("records insufficient balance as a risk refusal", async () => {
    const t = setup();
    t.db.set("portfolio", { ...t.db.portfolio(), usdc: 1, dayStartEquity: 1 });
    await t.engine.tick();
    expect(t.engine.monitor.snapshot().candidates[0].risk.reasons).toContain(
      "INSUFFICIENT_BALANCE",
    );
    t.db.close();
  });
  it("atomically persists the fill, independent accounting check and full sanitized candidate", async () => {
    const t = setup();
    await t.engine.tick();
    const s = t.engine.monitor.snapshot();
    expect(t.db.history("paper_trades")).toHaveLength(1);
    expect(s.accounting.latest?.ok).toBe(true);
    expect(s.accounting.ledger.ok).toBe(true);
    expect(s.candidates[0]).toMatchObject({
      side: "BUY",
      finalAction: "BUY",
      risk: { status: "ALLOWED" },
      profitGuard: { allowed: true },
      saleModel: "PROJECTED_TARGET",
    });
    expect(s.candidates[0].quotePriceUsdc).not.toBeNull();
    expect(s.accounting.totals.gasUsdc).toBe("0.03");
    expect(s.accounting.ledger.expectedGasUsdc).toBe("0.03");
    expect(s.lastTradeAt).not.toBeNull();
    t.db.close();
  });
  it("safely stops and retains a failed check without persisting a corrupted fill", async () => {
    const original = PaperTrading.prototype.fill;
    vi.spyOn(PaperTrading.prototype, "fill").mockImplementation(function (
      this: PaperTrading,
      ...args
    ) {
      const fill = original.apply(this, args);
      fill.portfolio.usdc += 0.01;
      return fill;
    });
    const t = setup();
    await t.engine.tick();
    expect(t.db.runtime()).toMatchObject({
      running: false,
      error: "PAPER_RECONCILIATION_FAILED",
    });
    expect(t.db.history("paper_trades")).toHaveLength(0);
    expect(t.engine.monitor.snapshot().accounting.latest?.ok).toBe(false);
    expect(t.engine.monitor.snapshot().candidates[0].finalAction).toBe(
      "SAFE_STOP",
    );
    t.db.close();
  });
  it("detects subsequent persisted balance corruption with the watchdog", async () => {
    const t = setup();
    await t.engine.tick();
    t.db.set("portfolio", {
      ...t.db.portfolio(),
      usdc: t.db.portfolio().usdc + 0.1,
    });
    t.engine.monitor.watchdog();
    expect(t.db.runtime()).toMatchObject({
      running: false,
      error: "PAPER_RECONCILIATION_FAILED",
    });
    expect(t.engine.monitor.snapshot().accounting.ledger.ok).toBe(false);
    t.db.close();
  });
  it("stops on the third consecutive failed API operation and does not resume after recovery", async () => {
    const db = new BotDatabase(":memory:");
    db.set("runtime", { ...db.runtime(), running: true });
    const m = new OperationMonitor(db);
    m.beginCycle();
    for (let i = 0; i < 3; i++)
      await expect(
        m.request("QUOTE", async () => {
          throw new Error("https://user:secret@example.invalid/?token=private");
        }),
      ).rejects.toThrow();
    expect(db.runtime()).toMatchObject({
      running: false,
      error: "CONSECUTIVE_API_ERRORS",
    });
    expect(m.snapshot().apiErrors).toBe(3);
    expect(m.snapshot().consecutiveErrors).toBe(3);
    expect(JSON.stringify(m.snapshot())).not.toContain("secret");
    expect(JSON.stringify(m.snapshot())).not.toContain("private");
    m.beginCycle();
    await m.request("HEALTH", async () => true);
    m.healthy();
    expect(m.snapshot().consecutiveErrors).toBe(0);
    expect(db.runtime().running).toBe(false);
    db.close();
  });
  it.each(["THIN_ORDERBOOK", "SPREAD_TOO_WIDE", "CANDLE_GAP", "STALE_CANDLES"])(
    "keeps %s as a market safety failure, not a repeated API outage",
    async (reason) => {
      const db = new BotDatabase(":memory:");
      db.set("runtime", { ...db.runtime(), running: true });
      const m = new OperationMonitor(db);
      for (let i = 0; i < 4; i++) {
        m.beginCycle();
        await expect(
          m.request("MARKET", async () => {
            throw Error(reason);
          }),
        ).rejects.toThrow(reason);
        m.failCycle(reason);
      }
      expect(db.runtime()).toMatchObject({ running: false, error: reason });
      expect(m.snapshot()).toMatchObject({
        apiErrors: 0,
        consecutiveErrors: 0,
      });
      const events = db.history<{ code: string; fatal: boolean }>(
        "operation_events",
        100,
      );
      expect(events.filter((e) => e.fatal)).toHaveLength(1);
      expect(events.some((e) => e.code === "CONSECUTIVE_API_ERRORS")).toBe(
        false,
      );
      db.close();
    },
  );
  it("retains the initiating stop reason while recording later failed monitoring", () => {
    const db = new BotDatabase(":memory:");
    db.set("runtime", { ...db.runtime(), running: true });
    const m = new OperationMonitor(db);
    m.beginCycle();
    m.failCycle("THIN_ORDERBOOK");
    m.beginCycle();
    m.failCycle("STALE_CANDLES");
    expect(db.runtime()).toMatchObject({
      running: false,
      error: "THIN_ORDERBOOK",
    });
    expect(m.safetySnapshot().lastStopReason).toBe("THIN_ORDERBOOK");
    const events = db.history<{ code: string; fatal: boolean }>(
      "operation_events",
      100,
    );
    expect(events.some((e) => e.code === "STALE_CANDLES")).toBe(true);
    expect(events.filter((e) => e.fatal).map((e) => e.code)).toEqual([
      "THIN_ORDERBOOK",
    ]);
    // An explicit reset permits a genuinely new stop to be recorded.
    db.set("runtime", { ...db.runtime(), error: null });
    m.transition("MANUAL_RESET");
    m.beginCycle();
    m.failCycle("SPREAD_TOO_WIDE");
    expect(m.safetySnapshot().lastStopReason).toBe("SPREAD_TOO_WIDE");
    expect(db.runtime().running).toBe(false);
    db.close();
  });
  it("detects stalled updates even if a market request is stuck", () => {
    const db = new BotDatabase(":memory:");
    db.set("runtime", { ...db.runtime(), running: true });
    const m = new OperationMonitor(db, now);
    m.market(now, now);
    m.watchdog(now + 360001);
    expect(db.runtime()).toMatchObject({
      running: false,
      error: "MARKET_DATA_STALLED",
    });
    db.close();
  });
  it("distinguishes stopped, delayed, healthy and abnormal states", () => {
    const db = new BotDatabase(":memory:");
    const m = new OperationMonitor(db, now);
    expect(m.snapshot(now).status).toBe("STOPPED");
    db.set("runtime", { ...db.runtime(), running: true });
    expect(m.snapshot(now).status).toBe("DATA_DELAYED");
    m.market(now, now);
    m.healthy(now);
    expect(m.snapshot(now).status).toBe("RUNNING");
    m.stop("MANUAL_FAILURE", now);
    expect(m.snapshot(now).status).toBe("ABNORMAL_STOP");
    db.close();
  });
  it("keeps persisted history and closes unclean uptime at the last confirmed heartbeat on boot", async () => {
    const folder = mkdtempSync(join(tmpdir(), "suiba-monitor-")),
      path = join(folder, "test.sqlite");
    try {
      let db = new BotDatabase(path);
      db.set("runtime", { ...db.runtime(), running: true, emergency: true });
      let m = new OperationMonitor(db, now);
      m.market(now, now);
      m.watchdog(now + 120000);
      db.close();
      db = new BotDatabase(path);
      m = new OperationMonitor(db, now + 300000);
      m.boot(now + 300000);
      expect(db.runtime()).toMatchObject({ running: false, emergency: true });
      expect(m.snapshot(now + 300000).runningMs).toBe(120000);
      expect(
        m
          .snapshot(now + 300000)
          .events.some((e) => e.code === "PROCESS_RESTART_STOPPED"),
      ).toBe(true);
      db.close();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  it("reports zero trades as a normal partial observation and never changes settings", () => {
    const db = new BotDatabase(":memory:");
    const m = new OperationMonitor(db, now),
      settings = db.settings();
    for (const hours of [24, 168] as const) {
      const r = m.report(hours, now);
      expect(r).toMatchObject({
        tradeCount: 0,
        winRate: null,
        netPnl: 0,
        profitGuardSkipped: 0,
        riskSkipped: 0,
        errors: 0,
        fullMonitoringCoverage: false,
      });
    }
    expect(db.settings()).toEqual(settings);
    db.close();
  });
  it("aggregates full 24h/7d intervals with an opening valuation and no 200-row history cap", () => {
    const db = new BotDatabase(":memory:"),
      m = new OperationMonitor(db, now - 8 * 86400000);
    const trade = (id: string, timestamp: number, pnl: number) =>
      ({
        orderId: id,
        side: "SELL",
        timestamp,
        pnl,
        quantity: 1,
        price: 2,
        fee: 0.03,
        slippage: 0,
        priceImpact: 0,
        costs: {
          gasUsdc: "0.03",
          additionalFeeUsdc: "0",
          dexFeeUsdc: null,
          source: "PAPER_MODEL",
        },
      }) satisfies Fill;
    db.append(
      "portfolio_snapshots",
      "old",
      { timestamp: now - 8 * 86400000, equity: 100 },
      now - 8 * 86400000,
    );
    db.append(
      "portfolio_snapshots",
      "baseline24",
      { timestamp: now - 86400001, equity: 110 },
      now - 86400001,
    );
    db.append(
      "portfolio_snapshots",
      "low",
      { timestamp: now - 3600000, equity: 99 },
      now - 3600000,
    );
    db.append(
      "portfolio_snapshots",
      "end",
      { timestamp: now, equity: 105 },
      now,
    );
    db.append(
      "paper_trades",
      "week",
      trade("week", now - 3 * 86400000, 2),
      now - 3 * 86400000,
    );
    for (let i = 0; i < 250; i++)
      db.append(
        "paper_trades",
        `today${i}`,
        trade(`today${i}`, now - 10000 + i, i % 2 ? 1 : -1),
        now - 10000 + i,
      );
    expect(m.report(24, now)).toMatchObject({
      tradeCount: 250,
      winRate: 0.5,
      netPnl: -5,
      maxDrawdown: 0.1,
      fullMonitoringCoverage: true,
    });
    expect(m.report(168, now)).toMatchObject({
      tradeCount: 251,
      netPnl: 5,
      maxDrawdown: 0.1,
    });
    db.close();
  });
  it("labels missing legacy gas as unknown instead of zero", () => {
    const db = new BotDatabase(":memory:"),
      m = new OperationMonitor(db);
    db.append(
      "paper_trades",
      "old",
      {
        orderId: "old",
        side: "BUY",
        timestamp: now,
        quantity: 1,
        price: 2,
        fee: 0.1,
        pnl: null,
        slippage: 0,
        priceImpact: 0,
      } satisfies Fill,
      now,
    );
    expect(m.snapshot().accounting.totals).toMatchObject({
      gasUsdc: null,
      unknownGasTrades: 1,
      feesUsdc: "0.1",
    });
    db.close();
  });
});

describe("independent PAPER accounting", () => {
  it("checks balances, realized/unrealized P&L, fees, and partial-sale basis within atomic tolerances", () => {
    const paper = new PaperTrading(),
      buy = quote("BUY", "5000000", now);
    const first = paper.fill(
      "b",
      "BUY",
      buy,
      initialPortfolio(now),
      defaults,
      now,
    );
    expect(
      reconcileFill(initialPortfolio(now), first.portfolio, first.trade, buy, 2)
        .ok,
    ).toBe(true);
    const sell = quote("SELL", atomic(first.portfolio.sui / 2, SUI), now);
    const second = paper.fill(
      "s",
      "SELL",
      sell,
      first.portfolio,
      defaults,
      now,
    );
    const check = reconcileFill(
      first.portfolio,
      second.portfolio,
      second.trade,
      sell,
      2,
    );
    expect(check.ok).toBe(true);
    expect(check.expected.allocatedCost).toBe(
      second.trade.allocatedCostUsdc!.replace(/0+$/, ""),
    );
    expect(check.tolerance.usdc).toBe(accountingTolerance.usdc);
    expect(check.tolerance.sui).toBe(accountingTolerance.sui);
  });
  it("rejects unknown gas, altered acquisition cost and altered realized P&L", () => {
    const paper = new PaperTrading(),
      before = initialPortfolio(now),
      q = quote("BUY", "5000000", now),
      fill = paper.fill("b", "BUY", q, before, defaults, now);
    expect(
      reconcileFill(
        before,
        fill.portfolio,
        { ...fill.trade, costs: { ...fill.trade.costs!, gasUsdc: null } },
        q,
        2,
      ).ok,
    ).toBe(false);
    expect(
      reconcileFill(
        before,
        fill.portfolio,
        {
          ...fill.trade,
          acquisition: { ...fill.trade.acquisition!, totalCostUsdc: "99" },
        },
        q,
        2,
      ).ok,
    ).toBe(false);
    expect(
      reconcileFill(
        before,
        { ...fill.portfolio, realized: 1 },
        fill.trade,
        q,
        2,
      ).ok,
    ).toBe(false);
  });
  it("prevents duplicate fills without losing the original trade", () => {
    const db = new BotDatabase(":memory:");
    db.set("runtime", { ...db.runtime(), running: true });
    const fill = new PaperTrading().fill(
      "same",
      "BUY",
      quote("BUY", "5000000", now),
      db.portfolio(),
      defaults,
      now,
    );
    db.commitFill("same", {}, fill.portfolio, fill.trade, db.runtime());
    expect(() =>
      db.commitFill("same", {}, fill.portfolio, fill.trade, db.runtime()),
    ).toThrow("DUPLICATE");
    expect(db.history("paper_trades")).toHaveLength(1);
    db.close();
  });
});

it("closes interrupted pending candidates on boot without adding a trade", async () => {
  const t = setup();
  await t.engine.tick();
  const original = t.engine.monitor.snapshot().candidates[0];
  t.db.putCandidate({
    ...original,
    id: "interrupted",
    orderId: "never-filled",
    finalAction: "PENDING",
  });
  const settings = t.db.settings();
  t.engine.monitor.boot();
  expect(
    t.engine.monitor.snapshot().candidates.find((c) => c.id === "interrupted"),
  ).toMatchObject({
    finalAction: "SAFE_STOP",
    reasons: ["PROCESS_RESTART_INTERRUPTED"],
  });
  expect(t.db.history("paper_trades")).toHaveLength(1);
  expect(t.db.settings()).toEqual(settings);
  expect(t.db.runtime().running).toBe(false);
  t.db.close();
});
it("detects cumulative gas and fill-count ledger corruption independently", async () => {
  const t = setup();
  await t.engine.tick();
  const trade = t.db.history<Fill>("paper_trades")[0];
  // Use a separate check referencing a missing fill to exercise durable ledger count/gas checks.
  const check =
    t.db.history<
      import("../packages/paper-trading/src/reconciliation.ts").AccountingCheck
    >("paper_checks")[0];
  t.db.append(
    "paper_checks",
    "extra-check",
    {
      ...check,
      orderId: "missing",
      expected: { ...check.expected, gasUsdc: "1" },
    },
    Date.now(),
  );
  const ledger = t.engine.monitor.snapshot().accounting.ledger;
  expect(ledger.ok).toBe(false);
  expect(ledger.reasons).toContain("GAS_LEDGER_MISMATCH");
  expect(ledger.reasons).toContain("FILL_LEDGER_COUNT_MISMATCH");
  expect(Number(trade.costs?.gasUsdc)).toBe(0.03);
  t.engine.monitor.watchdog();
  expect(t.db.runtime().running).toBe(false);
  t.db.close();
});
it("records unknown acquisition cost and stops without inventing a value", async () => {
  const t = setup("SELL");
  t.db.set("portfolio", { ...t.db.portfolio(), costBasis: null });
  await t.engine.tick();
  expect(t.db.runtime().running).toBe(false);
  expect(t.db.history("paper_trades")).toHaveLength(0);
  expect(t.engine.monitor.snapshot().accounting.ledger.reasons).toContain(
    "UNKNOWN_COST_BASIS",
  );
  t.db.close();
});

it("accepts one atomic-unit tolerance but rejects larger cash and quantity discrepancies", () => {
  const before = initialPortfolio(now),
    q = quote("BUY", "5000000", now),
    f = new PaperTrading().fill("units", "BUY", q, before, defaults, now);
  expect(
    reconcileFill(
      before,
      { ...f.portfolio, usdc: f.portfolio.usdc + 0.0000005 },
      f.trade,
      q,
      2,
    ).ok,
  ).toBe(true);
  expect(
    reconcileFill(
      before,
      { ...f.portfolio, usdc: f.portfolio.usdc + 0.000002 },
      f.trade,
      q,
      2,
    ).ok,
  ).toBe(false);
  expect(
    reconcileFill(
      before,
      { ...f.portfolio, sui: f.portfolio.sui + 0.0000000005 },
      f.trade,
      q,
      2,
    ).ok,
  ).toBe(true);
  expect(
    reconcileFill(
      before,
      { ...f.portfolio, sui: f.portfolio.sui + 0.000000002 },
      f.trade,
      q,
      2,
    ).ok,
  ).toBe(false);
});

it("rejects an internally consistent fill using costs different from the execution settings", async () => {
  const original = PaperTrading.prototype.fill;
  vi.spyOn(PaperTrading.prototype, "fill").mockImplementation(function (
    this: PaperTrading,
    ...args
  ) {
    const [id, side, q, p, s, stamp] = args;
    return original.call(
      this,
      id,
      side,
      q,
      p,
      { ...s, gasUsdc: s.gasUsdc + 0.1 },
      stamp,
    );
  });
  const t = setup();
  await t.engine.tick();
  expect(t.db.runtime()).toMatchObject({
    running: false,
    error: "PAPER_RECONCILIATION_FAILED",
  });
  expect(t.db.history("paper_trades")).toHaveLength(0);
  expect(t.engine.monitor.snapshot().accounting.latest?.reasons).toContain(
    "MISMATCH_MODELEDGAS",
  );
  t.db.close();
});

it("links running and stopped analyses to durable cycle start/end records without manufacturing orders", async () => {
  const t = setup("WAIT");
  try {
    await t.engine.tick();
    t.db.set("runtime", { ...t.db.runtime(), running: false });
    t.engine.monitor.transition("MANUAL_STOP");
    await t.engine.tick();
    const decisions = t.db.history<any>("strategy_decisions");
    expect(
      decisions.map((d) => d.analysisContext.runningAtAnalysis).sort(),
    ).toEqual([false, true]);
    const events = t.db.history<any>("cycle_audits");
    expect(events).toHaveLength(4);
    for (const d of decisions) {
      const rows = events.filter(
        (e) => e.cycleId === d.analysisContext.cycleId,
      );
      expect(rows.map((e) => e.phase).sort()).toEqual(["END", "START"]);
      expect(rows.find((e) => e.phase === "END").outcome).toBe(
        d.analysisContext.runningAtAnalysis ? "STRATEGY_WAIT" : "SAFETY_GATE",
      );
    }
    expect(t.db.history("operation_candidates")).toHaveLength(0);
  } finally {
    t.db.close();
  }
});
it("records failed acquisition as unevaluated rather than a strategy WAIT", async () => {
  const t = setup("BUY");
  try {
    t.market.candles.mockRejectedValue(new Error("CANDLE_GAP"));
    await t.engine.tick();
    const end = t.db
      .history<any>("cycle_audits")
      .find((e) => e.phase === "END");
    expect(end).toMatchObject({
      outcome: "FAILED",
      analysis: null,
      action: null,
      error: "CANDLE_GAP",
    });
    expect(t.db.history("strategy_decisions")).toHaveLength(0);
    expect(t.db.runtime().running).toBe(false);
  } finally {
    t.db.close();
  }
});

it("completes an isolated BUY and protective SELL with exact cash, fees, realized loss and atomic audit records", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 23, 3, 1));
  const t = setup("BUY");
  t.db.updateSettings({ ...t.db.settings(), maxOrder: 2 });
  try {
    await t.engine.tick();
    expect(t.db.portfolio()).toMatchObject({
      usdc: 97.964,
      sui: 0.997,
      costBasis: 2.036,
      fees: 0.036,
      realized: 0,
    });
    vi.setSystemTime(Date.now() + 300000);
    vi.mocked(RuleBasedStrategy.prototype.analyze).mockResolvedValue({
      action: "SELL",
      sellPurpose: "STOP_LOSS",
      confidence: 1,
      reason: "isolated protective-exit fixture",
      timestamp: new Date().toISOString(),
      stopLossPct: 0.02,
      takeProfitPct: 0.3,
    });
    await t.engine.tick();
    const p = t.db.portfolio();
    expect(p.usdc).toBeCloseTo(99.916053, 6);
    expect(p.realized).toBeCloseTo(-0.083947, 6);
    expect(p.fees).toBeCloseTo(0.071965, 6);
    expect(p.sui).toBe(0);
    expect(p.costBasis).toBe(0);
    for (const table of [
      "paper_orders",
      "paper_trades",
      "paper_checks",
      "operation_candidates",
    ] as const)
      expect(t.db.history(table)).toHaveLength(2);
    const trades = t.db.history<Fill>("paper_trades");
    expect(trades.find((x) => x.side === "SELL")?.pnl).toBeCloseTo(
      -0.083947,
      6,
    );
    for (const c of t.db.history<CandidateAudit>("operation_candidates"))
      expect(c).toMatchObject({
        profitGuard: { allowed: true },
        risk: { status: "ALLOWED" },
      });
    expect(t.db.history<any>("paper_checks").every((c) => c.ok)).toBe(true);
    expect(t.engine.monitor.ledger().ok).toBe(true);
    await t.engine.tick();
    expect(t.db.history("paper_trades")).toHaveLength(2); // same candle cannot double fill
  } finally {
    t.db.close();
    vi.useRealTimers();
  }
});
