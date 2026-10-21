import { apiAccess } from "../../../packages/shared/src/api.ts";
import { randomUUID } from "node:crypto";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import {
  Decimal,
  safeFailure,
  type QuoteResult,
} from "../../../packages/shared/src/index.ts";
import type {
  CandidateAudit,
  OperationEvent,
  OperationState,
  MarketStallDetails,
} from "../../../packages/shared/src/operations.ts";
import {
  accountingTolerance,
  type AccountingCheck,
} from "../../../packages/paper-trading/src/reconciliation.ts";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import { metrics } from "../../../packages/portfolio/src/index.ts";
const D = Decimal.clone({ precision: 60 });
export const monitoringLimits = {
  marketStaleMs: 360000,
  marketDelayedMs: 180000,
  consecutiveApiErrors: 3,
  heartbeatMs: 15000,
  fetchDeadlineMs: 45000,
};
const code = (value: string) =>
  /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : "UNKNOWN_FAILURE";
export const numericText = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    const n = new D(value);
    return n.isFinite() && n.gte(0) ? n.toString() : null;
  } catch {
    return null;
  }
};
export class OperationMonitor {
  private cycleFailed = false;
  private fetchMono: number | null = null;
  constructor(
    readonly db: BotDatabase,
    now = Date.now(),
    private monotonicNow: () => number = () => performance.now(),
  ) {
    if (!db.get("operation_state"))
      db.set("operation_state", {
        observedSince: now,
        processStartedAt: now,
        runningMs: 0,
        accountedAt: now,
        active: db.runtime().running,
        lastHeartbeatAt: now,
        lastMarketAt: null,
        lastMarketClosedAt: null,
        lastQuoteAt: null,
        lastQuoteExpiresAt: null,
        lastTradeAt: null,
        lastHealthyAt: null,
        apiErrors: 0,
        consecutiveErrors: 0,
      } satisfies OperationState);
  }
  state() {
    return {
      lastFetchAttemptAt: null,
      lastFetchSuccessAt: null,
      lastTransportSuccessAt: null,
      lastAnalysisAt: null,
      fetchStartedAt: null,
      lastFetchDurationMs: null,
      nextFetchAt: null,
      nextFetchReason: null,
      ...this.db.get<OperationState>("operation_state")!,
    };
  }
  private update(patch: Partial<OperationState>) {
    this.db.set("operation_state", { ...this.state(), ...patch });
  }
  event(
    kind: OperationEvent["kind"],
    reason: string,
    now = Date.now(),
    fatal = false,
    details?: MarketStallDetails,
  ) {
    this.db.append(
      "operation_events",
      randomUUID(),
      {
        timestamp: now,
        kind,
        code: code(reason),
        fatal,
        ...(details ? { details } : {}),
      } satisfies OperationEvent,
      now,
    );
  }
  boot(now = Date.now()) {
    const s = this.state();
    // After an unclean exit only confirmed heartbeats count; offline time is not PAPER uptime.
    this.update({
      runningMs:
        s.runningMs +
        (s.active ? Math.max(0, s.lastHeartbeatAt - s.accountedAt) : 0),
      accountedAt: now,
      active: false,
      processStartedAt: now,
      lastHeartbeatAt: now,
      fetchStartedAt: null,
      nextFetchAt: null,
      nextFetchReason: null,
    });
    this.fetchMono = null;
    this.db.set("runtime", { ...this.db.runtime(), running: false });
    this.db.interruptPending(now);
    this.event("BOOT", "PROCESS_RESTART_STOPPED", now);
  }
  transition(reason: string, now = Date.now(), details?: MarketStallDetails) {
    const s = this.state(),
      active = this.db.runtime().running;
    this.update({
      runningMs:
        s.runningMs + (s.active ? Math.max(0, now - s.accountedAt) : 0),
      accountedAt: now,
      active,
      lastHeartbeatAt: now,
    });
    this.event(
      active || reason === "MANUAL_RESET" ? "CONTROL" : "STOP",
      reason,
      now,
      false,
      details,
    );
  }
  beginCycle() {
    this.cycleFailed = false;
  }
  scheduled(at: number | null, reason: string | null = null) {
    this.update({ nextFetchAt: at, nextFetchReason: reason });
  }
  analysis(now = Date.now()) {
    this.update({ lastAnalysisAt: now });
  }
  transportSuccess(now = Date.now()) {
    this.update({ lastTransportSuccessAt: now });
  }
  async acquisition<T>(fn: () => Promise<T>): Promise<T> {
    if (this.fetchMono !== null) throw new Error("MARKET_FETCH_IN_PROGRESS");
    const began = Date.now();
    this.fetchMono = this.monotonicNow();
    this.update({ lastFetchAttemptAt: began, fetchStartedAt: began });
    const deadline = setTimeout(() => {
      const details = this.stallDetails(Date.now());
      if (this.db.runtime().running && details)
        this.failCycle("MARKET_DATA_STALLED", Date.now(), details);
    }, monitoringLimits.fetchDeadlineMs + 1);
    deadline.unref?.();
    try {
      const value = await this.request("MARKET", fn);
      this.update({ lastFetchSuccessAt: Date.now() });
      if (
        this.fetchMono != null &&
        this.monotonicNow() - this.fetchMono > monitoringLimits.fetchDeadlineMs
      ) {
        const details = this.stallDetails(Date.now());
        this.failCycle("MARKET_DATA_STALLED", Date.now(), details ?? undefined);
        throw new Error("MARKET_DATA_STALLED");
      }
      return value;
    } finally {
      clearTimeout(deadline);
      const elapsed =
        this.fetchMono == null
          ? null
          : Math.max(0, this.monotonicNow() - this.fetchMono);
      this.fetchMono = null;
      this.update({
        fetchStartedAt: null,
        lastFetchDurationMs: elapsed == null ? null : Math.round(elapsed),
      });
    }
  }
  timing(now = Date.now()) {
    const s = this.state(),
      boundary = Math.floor(now / 300000) * 300000;
    const candleAge =
      s.lastMarketClosedAt == null
        ? null
        : Math.max(0, now - s.lastMarketClosedAt);
    const updating =
      s.lastMarketClosedAt === boundary - 300000 &&
      now - boundary <= 60000 &&
      candleAge != null &&
      candleAge <= monitoringLimits.marketStaleMs;
    return {
      lastFetchAttemptAt: s.lastFetchAttemptAt ?? null,
      lastFetchSuccessAt: s.lastFetchSuccessAt ?? null,
      lastTransportSuccessAt: s.lastTransportSuccessAt ?? null,
      lastAnalysisAt: s.lastAnalysisAt ?? null,
      fetchStartedAt: s.fetchStartedAt ?? null,
      fetching: s.fetchStartedAt != null,
      fetchElapsedMs:
        this.fetchMono == null
          ? null
          : Math.max(0, this.monotonicNow() - this.fetchMono),
      lastFetchDurationMs: s.lastFetchDurationMs ?? null,
      nextFetchAt: s.nextFetchAt ?? null,
      nextFetchReason: s.nextFetchReason ?? null,
      candleAgeSeconds: candleAge == null ? null : candleAge / 1000,
      transportRecent:
        s.lastTransportSuccessAt != null &&
        now - s.lastTransportSuccessAt <= monitoringLimits.marketDelayedMs,
      dataStatus:
        candleAge == null
          ? "UNKNOWN"
          : candleAge > monitoringLimits.marketStaleMs
            ? "STALE"
            : updating
              ? "UPDATING"
              : "FRESH",
    };
  }
  private stallDetails(now: number): MarketStallDetails | null {
    const s = this.state(),
      t = this.timing(now);
    const reason: MarketStallDetails["reasonDetail"] | null =
      s.lastMarketClosedAt != null &&
      now - s.lastMarketClosedAt > monitoringLimits.marketStaleMs
        ? "CANDLE_STALE"
        : t.fetchElapsedMs != null &&
            t.fetchElapsedMs > monitoringLimits.fetchDeadlineMs
          ? "FETCH_DEADLINE_EXCEEDED"
          : s.lastMarketAt != null &&
              now - s.lastMarketAt > monitoringLimits.marketStaleMs
            ? "FETCH_SUCCESS_STALE"
            : s.lastMarketAt == null &&
                now - s.processStartedAt > monitoringLimits.marketStaleMs
              ? "NO_VALID_MARKET_DATA"
              : null;
    return reason
      ? {
          evaluatedAt: now,
          reasonDetail: reason,
          candleAgeSeconds: t.candleAgeSeconds,
          lastFetchSuccessAgeSeconds:
            s.lastFetchSuccessAt == null
              ? null
              : Math.max(0, now - s.lastFetchSuccessAt) / 1000,
          lastValidatedMarketAgeSeconds:
            s.lastMarketAt == null
              ? null
              : Math.max(0, now - s.lastMarketAt) / 1000,
          fetching: t.fetching,
          fetchStartedAt: t.fetchStartedAt,
          fetchElapsedMs: t.fetchElapsedMs,
          lastFetchDurationMs: t.lastFetchDurationMs,
          nextFetchAt: t.nextFetchAt,
          latestClosedAt: s.lastMarketClosedAt,
        }
      : null;
  }
  async request<T>(
    kind: "MARKET" | "QUOTE" | "HEALTH",
    fn: () => Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.cycleFailed = true;
      const s = this.state();
      this.update({
        apiErrors: s.apiErrors + 1,
        consecutiveErrors: s.consecutiveErrors + 1,
      });
      this.event("ERROR", `${kind}_${safeFailure(error)}`);
      if (
        this.state().consecutiveErrors === monitoringLimits.consecutiveApiErrors
      ) {
        this.event("ANOMALY", "CONSECUTIVE_API_ERRORS", Date.now(), true);
        this.stop("CONSECUTIVE_API_ERRORS");
      }
      throw error;
    }
  }
  market(closedAt: number, now = Date.now()) {
    this.update({ lastMarketAt: now, lastMarketClosedAt: closedAt });
  }
  quote(q: QuoteResult, now = Date.now()) {
    this.update({
      lastQuoteAt: now,
      lastQuoteExpiresAt: Number.isFinite(q.expiresAt) ? q.expiresAt : null,
    });
    if (q.expiresAt <= now) this.event("ANOMALY", "QUOTE_EXPIRED", now);
  }
  healthy(now = Date.now()) {
    if (!this.cycleFailed)
      this.update({ lastHealthyAt: now, consecutiveErrors: 0 });
    this.account(now);
  }
  private account(now: number) {
    const s = this.state();
    this.update({
      runningMs:
        s.runningMs + (s.active ? Math.max(0, now - s.accountedAt) : 0),
      accountedAt: now,
      active: this.db.runtime().running,
      lastHeartbeatAt: now,
    });
  }
  stop(reason: string, now = Date.now(), details?: MarketStallDetails) {
    const r = this.db.runtime();
    if (r.running || !r.error) {
      this.db.set("runtime", {
        ...r,
        running: false,
        error: r.error ?? code(reason),
      });
      this.transition(reason, now, details);
      if (details)
        console.warn(
          JSON.stringify({ event: "MARKET_DATA_STALLED", ...details }),
        );
    }
  }
  failCycle(reason: string, now = Date.now(), details?: MarketStallDetails) {
    if (!this.cycleFailed) this.event("ERROR", reason, now, false, details);
    this.cycleFailed = true;
    this.event("ANOMALY", reason, now, true, details);
    this.stop(reason, now, details);
  }
  watchdog(now = Date.now()) {
    const s = this.state(),
      r = this.db.runtime();
    const details = this.stallDetails(now);
    if (r.running && details)
      this.failCycle("MARKET_DATA_STALLED", now, details);
    if (this.db.runtime().running && !this.ledger().ok)
      this.failCycle("PAPER_RECONCILIATION_FAILED", now);
    this.account(now);
  }
  wait(now = Date.now()) {
    this.event("WAIT", "STRATEGY_WAIT", now);
  }
  finishCandidate(candidate: CandidateAudit) {
    this.db.putCandidate(candidate);
    for (const reason of candidate.reasons) {
      this.event("ANOMALY", reason, candidate.timestamp);
      if (
        [
          "UNKNOWN_COSTS",
          "INVALID_POSITION",
          "INVALID_PROFIT_CONFIG",
          "PAPER_RECONCILIATION_FAILED",
        ].includes(reason)
      )
        this.stop(reason, candidate.timestamp);
    }
  }
  filled(now = Date.now()) {
    this.update({ lastTradeAt: now });
  }
  valuation(price: number, now = Date.now()) {
    const p = this.db.portfolio(),
      s = this.db.settings();
    if (
      p.usdc + p.sui * price <= p.dayStartEquity * (1 - s.dailyLossPct) &&
      this.db.get("operation_loss_day") !== p.day
    ) {
      this.event("ANOMALY", "DAILY_LOSS_LIMIT", now);
      this.db.set("operation_loss_day", p.day);
    }
  }
  ledger(now = Date.now()) {
    const checks = this.db
        .range<AccountingCheck>("paper_checks", 0, now)
        .filter((c) => c.ok),
      trades = this.db.range<Fill>("paper_trades", 0, now);
    const ids = new Set(checks.map((c) => c.orderId)),
      verified = trades.filter((t) => ids.has(t.orderId));
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
      const check = checks.find((c) => c.orderId === t.orderId),
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
      p = this.db.portfolio();
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
  totals(trades: Fill[]) {
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
  report(hours: 24 | 168, now = Date.now()) {
    const from = now - hours * 3600000;
    const trades = this.db.range<Fill>("paper_trades", from, now),
      events = this.db.range<OperationEvent>("operation_events", from, now);
    type Point = { timestamp: number; equity: number };
    const prior = this.db.before<Point>("portfolio_snapshots", from),
      points = this.db.range<Point>("portfolio_snapshots", from, now);
    const values = [
      ...(prior ? [prior.equity] : []),
      ...points.map((p) => p.equity),
    ].filter(Number.isFinite);
    const closed = trades.flatMap((t) =>
      typeof t.pnl === "number" && Number.isFinite(t.pnl) ? [t.pnl] : [],
    );
    const m = metrics(values, closed),
      p = this.db.portfolio();
    const netPnl = values.length
      ? values.at(-1)! - values[0]
      : trades.length === 0 && p.sui === 0
        ? 0
        : null;
    return {
      hours,
      from,
      until: now,
      observedFrom: Math.max(from, this.state().observedSince),
      fullMonitoringCoverage: this.state().observedSince <= from,
      tradeCount: trades.length,
      buyCount: trades.filter((t) => t.side === "BUY").length,
      sellCount: closed.length,
      winRate: closed.length ? m.winRate : null,
      netPnl,
      maxDrawdown: values.length ? m.maxDrawdown : null,
      valuationBaselineAt: prior?.timestamp ?? points[0]?.timestamp ?? null,
      profitGuardSkipped: this.db.operationCounts(from, now).profitRejected,
      riskSkipped: this.db.operationCounts(from, now).riskRejected,
      errors: events.filter((e) => e.kind === "ERROR").length,
      anomalies: events.filter((e) => e.kind === "ANOMALY").length,
      stopReasons: events
        .filter((e) => e.kind === "STOP" || e.kind === "BOOT")
        .map((e) => ({ timestamp: e.timestamp, reason: e.code })),
      costs: this.totals(trades),
    };
  }
  snapshot(now = Date.now()) {
    const s = this.state(),
      r = this.db.runtime();
    const p = this.db.portfolio(),
      price = this.db.get<number>("price") ?? null;
    const delayed =
      s.lastMarketAt === null ||
      s.lastMarketClosedAt === null ||
      now - s.lastMarketAt > monitoringLimits.marketDelayedMs ||
      now - s.lastMarketClosedAt > monitoringLimits.marketStaleMs;
    return {
      timing: this.timing(now),
      apis: apiAccess.snapshot(now),
      mode: "PAPER" as const,
      status:
        r.emergency || r.error
          ? "ABNORMAL_STOP"
          : !r.running
            ? "STOPPED"
            : delayed
              ? "DATA_DELAYED"
              : "RUNNING",
      observedSince: s.observedSince,
      processStartedAt: s.processStartedAt,
      runningMs:
        s.runningMs +
        (s.active
          ? Math.max(
              0,
              Math.min(
                now,
                s.lastHeartbeatAt + monitoringLimits.heartbeatMs * 2,
              ) - s.accountedAt,
            )
          : 0),
      lastMarketAt: s.lastMarketAt,
      lastMarketClosedAt: s.lastMarketClosedAt,
      lastQuoteAt: s.lastQuoteAt,
      lastQuoteExpiresAt: s.lastQuoteExpiresAt,
      lastTradeAt:
        this.db.history<Fill>("paper_trades", 1)[0]?.timestamp ?? s.lastTradeAt,
      lastHealthyAt: s.lastHealthyAt,
      lastHeartbeatAt: s.lastHeartbeatAt,
      actions: this.db.operationCounts(),
      apiErrors: s.apiErrors,
      consecutiveErrors: s.consecutiveErrors,
      stopReason: r.emergency ? "EMERGENCY_STOP" : r.error,
      accounting: {
        current: {
          usdc: p.usdc,
          sui: p.sui,
          costBasis: p.costBasis,
          realized: p.realized,
          fees: p.fees,
          unrealized: price == null ? null : p.sui * price - p.costBasis,
          equity:
            price == null
              ? p.sui === 0
                ? p.usdc
                : null
              : p.usdc + p.sui * price,
          price,
        },
        latest: this.db.history<AccountingCheck>("paper_checks", 1)[0] ?? null,
        totals: this.totals(this.db.range<Fill>("paper_trades", 0, now)),
        ledger: this.ledger(now),
      },
      reports: [this.report(24, now), this.report(168, now)],
      candidates: this.db.history<CandidateAudit>("operation_candidates", 50),
      events: this.db.history<OperationEvent>("operation_events", 50),
      limits: monitoringLimits,
    };
  }
}
