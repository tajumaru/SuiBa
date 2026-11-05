import type { BotDatabase } from "../../../packages/database/src/index.ts";
import {
  Decimal,
  type TradingDecision,
} from "../../../packages/shared/src/index.ts";
import type {
  OperationEvent,
  OperationState,
} from "../../../packages/shared/src/operations.ts";
import {
  accountingTolerance,
  type AccountingCheck,
} from "../../../packages/paper-trading/src/reconciliation.ts";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import { metrics } from "../../../packages/portfolio/src/index.ts";

/**
 * Read-only accounting, reporting and decision telemetry for
 * OperationMonitor, extracted as standalone functions over the
 * database so the monitor class stays focused on cycle safety.
 * operations.ts re-exports the shared helpers and keeps thin
 * delegating methods, so existing imports are unchanged.
 */
const D = Decimal.clone({ precision: 60 });

export const monitoringLimits = {
  marketStaleMs: 360000,
  marketDelayedMs: 180000,
  consecutiveApiErrors: 3,
  heartbeatMs: 15000,
  fetchDeadlineMs: 45000,
};

/**
 * Read-only telemetry for the dashboard's narration feed: a validated
 * copy of the latest decision evidence the engine already recorded in
 * the database (`decision` key, written by `recordAnalysis` on every
 * analysed cycle). It is assembled inside `snapshot()` from stored
 * records only — it never runs the strategy, never touches an order
 * gate, and returns null whenever the stored evidence is missing,
 * malformed, or from an unknown evidence version (fail-closed), so the
 * dashboard narrates nothing it cannot ground in a real record.
 */
export interface DecisionTelemetry {
  evaluatedAt: number;
  /** Closed five-minute candle time in milliseconds. Evidence stores its
   * opening time in seconds, matching the strategy's Candle contract. */
  candleTimestamp: number;
  action: TradingDecision["action"];
  reason: string;
  selectedRule: string;
  sellPurpose: string | null;
  price: number;
  entryPrice: number | null;
  ema20: number;
  ema50: number;
  rsi: number;
  previousRsi: number;
  histogram: number;
  previousHistogram: number;
  atr: number;
  volumeChange: number;
  oversold: number;
  overbought: number;
  stopLossPct: number;
  takeProfitPct: number;
  /** The buy-run line (display-only): the next close at which RSI
   * would reach the oversold line, recorded when RSI was the only
   * missing buy piece. Absent or invalid in the evidence reads as
   * null here rather than failing the whole telemetry closed,
   * because the field only steers display. */
  rsiLinePrice: number | null;
  conditions: {
    emaUp: boolean;
    /** EMA counted as met via the gap-shrink route, not the cross.
     * Absent in evidence recorded before the option existed; the
     * mapping below reads that as false rather than failing closed,
     * because this flag only steers display wording. */
    emaGapShrinking: boolean;
    rsiRecovery: boolean;
    histogramImproving: boolean;
    hasPosition: boolean;
    stopLoss: boolean;
    takeProfit: boolean;
  };
}

export const numericText = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const n = new D(value);
    return n.isFinite() && n.gte(0) ? n.toString() : null;
  } catch {
    return null;
  }
};

export function computeLedger(db: BotDatabase, now: number) {
  const checks = db
      .range<AccountingCheck>("paper_checks", 0, now)
      .filter((c) => c.ok),
    trades = db.range<Fill>("paper_trades", 0, now);
  const ids = new Set(checks.map((c) => c.orderId)),
    verified = trades.filter((t) => ids.has(t.orderId));
  // Preserve find's first strict-equality match, including malformed IDs.
  const firstCheck = new Map<AccountingCheck["orderId"], AccountingCheck>();
  for (const c of checks)
    if (c.orderId === c.orderId && !firstCheck.has(c.orderId))
      firstCheck.set(c.orderId, c);
  let expectedGas = new D(0),
    actualGas = new D(0);
  const reasons: string[] = [];
  for (const c of checks) {
    const gas = numericText(c.expected.gasUsdc);
    if (gas === null) reasons.push("UNKNOWN_COSTS");
    else expectedGas = expectedGas.plus(gas);
  }
  for (const t of verified) {
    const gas = numericText(t.costs?.gasUsdc);
    if (gas === null) reasons.push("UNKNOWN_COSTS");
    else actualGas = actualGas.plus(gas);
    const check = firstCheck.get(t.orderId),
      fee = numericText(t.fee);
    if (
      fee === null ||
      check?.expected.tradeFee == null ||
      new D(fee)
        .minus(check.expected.tradeFee)
        .abs()
        .gt(accountingTolerance.usdc)
    )
      reasons.push("FEE_LEDGER_MISMATCH");
  }
  if (checks.length !== verified.length)
    reasons.push("FILL_LEDGER_COUNT_MISMATCH");
  if (expectedGas.minus(actualGas).abs().gt(accountingTolerance.usdc))
    reasons.push("GAS_LEDGER_MISMATCH");
  const latest = checks.at(-1),
    p = db.portfolio();
  if (
    ![p.usdc, p.sui, p.costBasis, p.fees, p.realized].every(
      Number.isFinite,
    ) ||
    [p.usdc, p.sui, p.costBasis, p.fees].some((v) => v < 0)
  )
    reasons.push("INVALID_ACCOUNTING_DATA");
  if (p.sui > 0 && !Number.isFinite(p.costBasis))
    reasons.push("UNKNOWN_COST_BASIS");
  if (latest)
    for (const key of [
      "usdc",
      "sui",
      "costBasis",
      "realized",
      "fees",
    ] as const) {
      try {
        if (
          new D(p[key])
            .minus(latest.expected[key]!)
            .abs()
            .gt(
              key === "sui"
                ? accountingTolerance.sui
                : accountingTolerance.usdc,
            )
        )
          reasons.push(`LEDGER_${key.toUpperCase()}_MISMATCH`);
      } catch {
        reasons.push("INVALID_ACCOUNTING_DATA");
      }
    }
  return {
    ok: reasons.length === 0,
    reasons,
    expectedGasUsdc: expectedGas.toString(),
    actualGasUsdc: actualGas.toString(),
    verifiedFills: verified.length,
    legacyFills: trades.length - verified.length,
  };
}

export function computeTotals(trades: Fill[]) {
  let fees = new D(0),
    gas = new D(0),
    dex = new D(0),
    unknownFees = 0,
    unknownGas = 0,
    unknownDex = 0;
  for (const t of trades) {
    const f = numericText(t.fee);
    if (f === null) unknownFees++;
    else fees = fees.plus(f);
    const g = numericText(t.costs?.gasUsdc),
      d = numericText(t.costs?.dexFeeUsdc);
    if (g === null) unknownGas++;
    else gas = gas.plus(g);
    if (d === null) unknownDex++;
    else dex = dex.plus(d);
  }
  return {
    feesUsdc: unknownFees ? null : fees.toString(),
    knownFeesUsdc: fees.toString(),
    unknownFeeTrades: unknownFees,
    gasUsdc: unknownGas ? null : gas.toString(),
    knownGasUsdc: gas.toString(),
    unknownGasTrades: unknownGas,
    dexFeeUsdc: unknownDex ? null : dex.toString(),
    knownDexFeeUsdc: dex.toString(),
    unknownDexTrades: unknownDex,
  };
}

export function computeReport(
  db: BotDatabase,
  state: OperationState,
  hours: 24 | 168,
  now: number,
) {
  const from = now - hours * 3600000;
  const counts = db.operationCounts(from, now);
  const trades = db.range<Fill>("paper_trades", from, now),
    events = db.range<OperationEvent>("operation_events", from, now);
  type Point = { timestamp: number; equity: number };
  const prior = db.before<Point>("portfolio_snapshots", from),
    points = db.range<Point>("portfolio_snapshots", from, now);
  const values = [
    ...(prior ? [prior.equity] : []),
    ...points.map((p) => p.equity),
  ].filter(Number.isFinite);
  const closed = trades.flatMap((t) =>
    typeof t.pnl === "number" && Number.isFinite(t.pnl) ? [t.pnl] : [],
  );
  const m = metrics(values, closed),
    p = db.portfolio();
  const netPnl = values.length
    ? values.at(-1)! - values[0]
    : trades.length === 0 && p.sui === 0
      ? 0
      : null;
  return {
    hours,
    from,
    until: now,
    observedFrom: Math.max(from, state.observedSince),
    fullMonitoringCoverage: state.observedSince <= from,
    tradeCount: trades.length,
    buyCount: trades.filter((t) => t.side === "BUY").length,
    sellCount: closed.length,
    winRate: closed.length ? m.winRate : null,
    netPnl,
    maxDrawdown: values.length ? m.maxDrawdown : null,
    valuationBaselineAt: prior?.timestamp ?? points[0]?.timestamp ?? null,
    profitGuardSkipped: counts.profitRejected,
    riskSkipped: counts.riskRejected,
    errors: events.filter((e) => e.kind === "ERROR").length,
    anomalies: events.filter((e) => e.kind === "ANOMALY").length,
    stopReasons: events
      .filter((e) => e.kind === "STOP" || e.kind === "BOOT")
      .map((e) => ({ timestamp: e.timestamp, reason: e.code })),
    costs: computeTotals(trades),
  };
}

  /** Optional display data only. SQL faults are latched by BotDatabase.sql;
   * returning null here never clears that latch or grants order permission. */
export function readDisplayDecision(
  db: BotDatabase,
): TradingDecision | null {
  try {
    return db.get<TradingDecision>("decision") ?? null;
  } catch {
    return null;
  }
}

export function buildDecisionTelemetry(
  d: TradingDecision | null,
  now: number,
): DecisionTelemetry | null {
  const e = d?.evidence,
    t = e?.thresholds,
    cur = e?.inputs?.current,
    prev = e?.inputs?.previous,
    cond = e?.conditions;
  if (!d || !e || e.version !== 1 || !t || !cur || !prev || !cond)
    return null;
  if (!["BUY", "SELL", "WAIT"].includes(d.action)) return null;
  const entry = e.inputs.entryPrice;
  const nums = [
    e.evaluatedAt,
    e.candleTimestamp,
    e.inputs.price,
    cur.ema20,
    cur.ema50,
    cur.rsi,
    prev.rsi,
    cur.histogram,
    prev.histogram,
    cur.atr,
    cur.volumeChange,
    t.oversold,
    t.overbought,
    t.stopLossPct,
    t.takeProfitPct,
  ];
  if (
    !nums.every((n) => typeof n === "number" && Number.isFinite(n)) ||
    (entry !== null && (typeof entry !== "number" || !Number.isFinite(entry)))
  )
    return null;
  const conditionKeys = [
    "emaUp",
    "rsiRecovery",
    "histogramImproving",
    "hasPosition",
    "stopLoss",
    "takeProfit",
  ] as const;
  if (!conditionKeys.every((k) => typeof cond[k] === "boolean")) return null;
  const candleTimestamp = (e.candleTimestamp + 300) * 1000;
  if (
    e.evaluatedAt <= 0 ||
    e.evaluatedAt > now ||
    now - e.evaluatedAt > monitoringLimits.marketStaleMs ||
    e.candleTimestamp <= 0 ||
    !Number.isSafeInteger(e.candleTimestamp) ||
    !Number.isSafeInteger(candleTimestamp) ||
    candleTimestamp > e.evaluatedAt ||
    now - candleTimestamp > monitoringLimits.marketStaleMs ||
    e.inputs.price <= 0 ||
    (entry !== null && entry <= 0) ||
    cur.ema20 <= 0 ||
    cur.ema50 <= 0 ||
    cur.atr < 0 ||
    cur.rsi < 0 ||
    cur.rsi > 100 ||
    prev.rsi < 0 ||
    prev.rsi > 100 ||
    t.oversold < 0 ||
    t.overbought > 100 ||
    t.oversold >= t.overbought ||
    t.stopLossPct < 0 ||
    t.stopLossPct >= 1 ||
    t.takeProfitPct < 0 ||
    typeof e.selectedRule !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,100}$/.test(e.selectedRule) ||
    (d.sellPurpose != null &&
      ![
        "TAKE_PROFIT",
        "STOP_LOSS",
        "STRATEGY_EXIT",
        "RISK_REDUCTION",
        "EMERGENCY_EXIT",
      ].includes(d.sellPurpose))
  )
    return null;
  return {
    evaluatedAt: e.evaluatedAt,
    candleTimestamp,
    action: d.action,
    reason: typeof d.reason === "string" ? d.reason : "",
    selectedRule: e.selectedRule,
    sellPurpose: d.sellPurpose ?? null,
    price: e.inputs.price,
    entryPrice: entry,
    ema20: cur.ema20,
    ema50: cur.ema50,
    rsi: cur.rsi,
    previousRsi: prev.rsi,
    histogram: cur.histogram,
    previousHistogram: prev.histogram,
    atr: cur.atr,
    volumeChange: cur.volumeChange,
    oversold: t.oversold,
    overbought: t.overbought,
    stopLossPct: t.stopLossPct,
    takeProfitPct: t.takeProfitPct,
    rsiLinePrice:
      typeof e.rsiLinePrice === "number" &&
      Number.isFinite(e.rsiLinePrice) &&
      e.rsiLinePrice > 0
        ? e.rsiLinePrice
        : null,
    conditions: {
      emaUp: cond.emaUp,
      emaGapShrinking: cond.emaGapShrinking === true,
      rsiRecovery: cond.rsiRecovery,
      histogramImproving: cond.histogramImproving,
      hasPosition: cond.hasPosition,
      stopLoss: cond.stopLoss,
      takeProfit: cond.takeProfit,
    },
  };
}
