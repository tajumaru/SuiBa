import { abortable } from "../../../packages/shared/src/read-budget.ts";
import { botControlState } from "../../../packages/shared/src/bot-state.ts";
import { withReadBudget } from "../../../packages/shared/src/read-budget-node.ts";
import {
  initialPaperSafety,
  recoverableReadFailure,
  paperRecoveryLimits,
  type PaperSafetyState,
  type PaperRecoveryProof,
} from "../../../packages/shared/src/paper-recovery.ts";
import type { ApiFailure } from "../../../packages/shared/src/http-errors.ts";
import { apiAccess } from "../../../packages/shared/src/api.ts";
import { randomUUID } from "node:crypto";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import {
  Decimal,
  safeFailure,
  type QuoteResult,
  type TradingDecision,
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
export class OperationMonitor {
  private cycleFailed = false;
  private cycleGeneration = 0;
  private softFailureThisCycle = false;
  private recoveryProofUsed = false;
  safety(): PaperSafetyState {
    return {
      ...initialPaperSafety(),
      ...this.db.get<PaperSafetyState>("paper_safety"),
    };
  }
  private saveSafety(patch: Partial<PaperSafetyState>) {
    this.db.set("paper_safety", { ...this.safety(), ...patch });
  }
  transientFailure(
    api: string,
    reason: string,
    failure?: ApiFailure,
    now = Date.now(),
  ) {
    if (
      !recoverableReadFailure(failure) ||
      failure.api !== api ||
      failure.code !== reason ||
      Math.abs(now - failure.occurredAt) > 1000
    ) {
      this.stop(reason, now);
      return;
    }
    const r = this.db.runtime(),
      s = this.safety();
    this.softFailureThisCycle = true;
    this.saveSafety({
      connectivity: "DEGRADED",
      generation: s.generation + 1,
      resumePending: s.resumePending || (r.running && !r.error && !r.emergency),
      episodeAt: s.episodeAt ?? now,
      lastFailureAt: now,
      latestFailure: failure,
      failures: s.failures + 1,
      healthyCycles: 0,
      firstHealthyAt: null,
      lastHealthyCycleAt: null,
      recoveredAt: null,
    });
    // Runtime remains the final execution gate; transient degradation never grants intent.
    this.db.set("runtime", { ...r, running: false });
    if (r.running) this.transition("PAPER_NETWORK_PAUSED", now);
    this.checkRecoveryDeadline(now);
  }
  transientCycleFailure(reason: string) {
    const f = this.safety().latestFailure;
    return (
      this.softFailureThisCycle &&
      !!f &&
      (reason === f.code ||
        (f.api === "Sui gRPC" && reason === "SUI_READ_FAILED"))
    );
  }
  checkRecoveryDeadline(now = Date.now()) {
    const s = this.safety();
    if (
      s.resumePending &&
      ((s.episodeAt != null &&
        now - s.episodeAt >= paperRecoveryLimits.maxEpisodeMs) ||
        s.failures >= paperRecoveryLimits.maxFailures)
    )
      this.stop("PAPER_RECOVERY_EXHAUSTED", now);
  }
  ordersAllowed(generation?: number, now = Date.now()) {
    if (!this.db.health().healthy) return false;
    const r = this.db.runtime(),
      s = this.state();
    return (
      this.mode === "PAPER" &&
      (generation == null || generation === this.safety().generation) &&
      r.running &&
      !r.error &&
      !r.emergency &&
      this.fetchMono === null &&
      s.lastMarketAt !== null &&
      now - s.lastMarketAt <= monitoringLimits.marketDelayedMs &&
      s.lastMarketClosedAt !== null &&
      now - s.lastMarketClosedAt <= monitoringLimits.marketStaleMs &&
      this.safety().connectivity === "HEALTHY" &&
      !apiAccess.blocked()
    );
  }

  recoveryCycle(checks: { market: boolean; sui: boolean }, now = Date.now()) {
    if (!this.db.health().healthy) return false;
    const s = this.safety(),
      r = this.db.runtime();
    if (s.connectivity === "HEALTHY" || this.recoveryProofUsed) return false;
    this.checkRecoveryDeadline(now);
    // A failure or control action during this cycle invalidates its entire proof.
    if (
      this.softFailureThisCycle ||
      this.cycleFailed ||
      this.cycleGeneration !== s.generation
    )
      return false;
    if (!checks.market || !checks.sui || apiAccess.blocked()) return false;
    if (!this.ledger().ok) {
      this.failCycle("PAPER_RECONCILIATION_FAILED", now);
      return false;
    }
    const stalled = this.stallDetails(now);
    if (stalled) {
      this.failCycle("MARKET_DATA_STALLED", now, stalled);
      return false;
    }
    if (
      s.lastHealthyCycleAt != null &&
      now - s.lastHealthyCycleAt < paperRecoveryLimits.minimumCycleSpacingMs
    )
      return false;
    this.recoveryProofUsed = true;
    const count = s.healthyCycles + 1,
      first = s.firstHealthyAt ?? now;
    if (
      count < paperRecoveryLimits.healthyCycles ||
      now - first < paperRecoveryLimits.minimumHealthyMs
    ) {
      this.saveSafety({
        connectivity: "RECOVERING",
        healthyCycles: count,
        firstHealthyAt: first,
        lastHealthyCycleAt: now,
      });
      return false;
    }
    const resume =
      s.resumePending &&
      !this.db.runtime().error &&
      !r.emergency &&
      this.mode === "PAPER";
    this.saveSafety({
      connectivity: "HEALTHY",
      healthyCycles: count,
      firstHealthyAt: first,
      lastHealthyCycleAt: now,
      episodeAt: null,
      failures: 0,
      resumePending: false,
      recoveredAt: resume ? now : null,
    });
    if (resume) {
      this.db.set("runtime", { ...this.db.runtime(), running: true });
      this.transition("PAPER_NETWORK_RECOVERED", now, undefined, {
        mode: "PAPER",
        healthyCycles: count,
        firstHealthyAt: first,
        lastFailureAt: s.lastFailureAt!,
        confirmedAt: now,
        generation: s.generation,
        marketHealthy: true,
        suiHealthy: true,
        ledgerHealthy: true,
        backoff: false,
      });
    }
    return resume;
  }

  private fetchMono: number | null = null;
  constructor(
    readonly db: BotDatabase,
    now = Date.now(),
    private monotonicNow: () => number = () => performance.now(),
    private readonly mode: string = "PAPER",
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
    recoveryProof?: PaperRecoveryProof,
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
        ...(recoveryProof ? { recoveryProof } : {}),
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
    this.saveSafety({
      ...initialPaperSafety(),
      generation: this.safety().generation + 1,
      lastStopReason: this.safety().lastStopReason,
    });
    this.db.set("runtime", { ...this.db.runtime(), running: false });
    this.db.interruptPending(now);
    this.event("BOOT", "PROCESS_RESTART_STOPPED", now);
  }
  transition(
    reason: string,
    now = Date.now(),
    details?: MarketStallDetails,
    recoveryProof?: PaperRecoveryProof,
  ) {
    if (
      [
        "MANUAL_STOP",
        "EMERGENCY_STOP",
        "MANUAL_RESET",
        "MANUAL_START",
        "PROCESS_SHUTDOWN",
      ].includes(reason)
    )
      this.saveSafety({
        resumePending: false,
        generation: this.safety().generation + 1,
        healthyCycles: 0,
        firstHealthyAt: null,
        lastHealthyCycleAt: null,
        recoveredAt: null,
      });
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
      recoveryProof,
    );
  }
  beginCycle() {
    this.cycleFailed = false;
    this.softFailureThisCycle = false;
    this.recoveryProofUsed = false;
    this.cycleGeneration = this.safety().generation;
    return this.cycleGeneration;
  }
  scheduled(at: number | null, reason: string | null = null) {
    this.update({ nextFetchAt: at, nextFetchReason: reason });
  }
  analysis(now = Date.now()) {
    this.update({ lastAnalysisAt: now });
  }
  apiFailure(failure: ApiFailure) {
    this.db.set("latest_api_failure", failure);
    this.db.append(
      "operation_events",
      randomUUID(),
      {
        timestamp: failure.occurredAt,
        kind: "API",
        code: failure.code,
        apiFailure: failure,
      } satisfies OperationEvent,
      failure.occurredAt,
    );
  }
  transportSuccess(now = Date.now()) {
    this.update({ lastTransportSuccessAt: now });
  }
  async acquisition<T>(fn: () => Promise<T>, cycleId?: string): Promise<T> {
    if (this.fetchMono !== null) throw new Error("MARKET_FETCH_IN_PROGRESS");
    const began = Date.now();
    this.fetchMono = this.monotonicNow();
    this.update({ lastFetchAttemptAt: began, fetchStartedAt: began });
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      const details = this.stallDetails(Date.now());
      controller.abort(new Error("MARKET_DATA_STALLED"));
      if ((this.db.runtime().running || this.safety().resumePending) && details)
        this.failCycle("MARKET_DATA_STALLED", Date.now(), details);
    }, monitoringLimits.fetchDeadlineMs + 1);
    deadline.unref?.();
    try {
      const value = await this.request("MARKET", () =>
        withReadBudget(
          controller.signal,
          this.safety().connectivity !== "HEALTHY",
          () => abortable(fn(), controller.signal),
          cycleId,
        ),
      );
      controller.signal.throwIfAborted();
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
        !this.softFailureThisCycle &&
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
    this.saveSafety({
      resumePending: false,
      generation: this.safety().generation + 1,
      lastStopReason: code(reason),
      recoveredAt: null,
    });
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
    this.db.assertHealthy();
    const s = this.state(),
      r = this.db.runtime();
    const details = this.stallDetails(now);
    this.checkRecoveryDeadline(now);
    if ((r.running || this.safety().resumePending) && details)
      this.failCycle("MARKET_DATA_STALLED", now, details);
    if (
      (this.db.runtime().running || this.safety().resumePending) &&
      !this.ledger().ok
    )
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
    const counts = this.db.operationCounts(from, now);
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
      profitGuardSkipped: counts.profitRejected,
      riskSkipped: counts.riskRejected,
      errors: events.filter((e) => e.kind === "ERROR").length,
      anomalies: events.filter((e) => e.kind === "ANOMALY").length,
      stopReasons: events
        .filter((e) => e.kind === "STOP" || e.kind === "BOOT")
        .map((e) => ({ timestamp: e.timestamp, reason: e.code })),
      costs: this.totals(trades),
    };
  }
  safetySnapshot(now = Date.now()) {
    const r = this.db.runtime();
    return {
      ...this.safety(),
      controlState: botControlState({
        ...r,
        ...this.safety(),
        databaseHealthy: this.db.health().healthy,
        ordersAllowed: this.ordersAllowed(undefined, now),
      }),
      botState: r.emergency
        ? "EMERGENCY_STOP"
        : r.error
          ? "ABNORMAL_STOP"
          : !r.running && !this.safety().resumePending
            ? "MANUAL_STOP"
            : this.safety().connectivity,
      lastMarketSuccessAt: this.state().lastFetchSuccessAt,
      latestApiError:
        apiAccess
          .snapshot(now)
          .flatMap((a) => (a.lastFailure ? [a.lastFailure] : []))
          .concat(
            this.db.get<ApiFailure>("latest_api_failure") ??
              this.safety().latestFailure ??
              [],
          )
          .sort((a, b) => b.occurredAt - a.occurredAt)[0] ?? null,
      ordersAllowed: this.ordersAllowed(undefined, now),
      limits: paperRecoveryLimits,
    };
  }
  /** Optional display data only. SQL faults are latched by BotDatabase.sql;
   * returning null here never clears that latch or grants order permission. */
  displayDecision(): TradingDecision | null {
    try {
      return this.db.get<TradingDecision>("decision") ?? null;
    } catch {
      return null;
    }
  }
  decisionTelemetry(now = Date.now()): DecisionTelemetry | null {
    const d = this.displayDecision();
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
  snapshot(now = Date.now()) {
    // Read optional telemetry first so a SQL fault discovered here is reflected
    // in this same response's runtime, safety state and order gate.
    const decision = this.decisionTelemetry(now);
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
      safety: this.safetySnapshot(now),
      timing: this.timing(now),
      decision,
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
