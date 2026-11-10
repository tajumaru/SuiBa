import { abortable } from "../../../packages/shared/src/read-budget.ts";
import { botControlState } from "../../../packages/shared/src/bot-state.ts";
import { withReadBudget } from "../../../packages/shared/src/read-budget-node.ts";
import {
  episodeLimits,
  episodeSummaryOf,
  initialPaperSafety,
  recoverableReadFailure,
  paperRecoveryLimits,
  type EpisodeSummary,
  type PaperSafetyState,
  type PaperRecoveryProof,
} from "../../../packages/shared/src/paper-recovery.ts";
import type { ApiFailure } from "../../../packages/shared/src/http-errors.ts";
import { workerBuild } from "./buildInfo.ts";
import { apiAccess } from "../../../packages/shared/src/api.ts";
import { randomUUID } from "node:crypto";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import {
  safeFailure,
  type QuoteResult,
  type TradingDecision,
} from "../../../packages/shared/src/index.ts";
import {
  indexerLatencyKinds,
  type CandidateAudit,
  type IndexerLatencyAggregate,
  type IndexerLatencyBucket,
  type IndexerLatencyKind,
  type OperationEvent,
  type OperationState,
  type MarketStallDetails,
} from "../../../packages/shared/src/operations.ts";
import type { AccountingCheck } from "../../../packages/paper-trading/src/reconciliation.ts";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import {
  buildDecisionTelemetry,
  computeLedger,
  computeReport,
  computeTotals,
  monitoringLimits,
  numericText,
  readDisplayDecision,
  type DecisionTelemetry,
} from "./operations-report.ts";
export { monitoringLimits, numericText };
export type { DecisionTelemetry };
const code = (value: string) =>
  /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : "UNKNOWN_FAILURE";
export class OperationMonitor {
  private shutdownRequested = false;
  get shuttingDown() {
    return this.shutdownRequested;
  }
  beginShutdown() {
    this.shutdownRequested = true;
    this.db.set("runtime", { ...this.db.runtime(), running: false });
  }
  isShutdownCancellation(error: unknown) {
    return (
      this.shutdownRequested &&
      error instanceof Error &&
      error.message === "API_CANCELLED"
    );
  }
  // A failed recovery read cannot grant orders even if stop persistence also fails.
  private recoveryReadFault = false;
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
    const tally = { ...(s.episodeAt == null ? {} : s.episodeTally) },
      tallyKey = `${failure.api}/${failure.code}`;
    tally[tallyKey] = (tally[tallyKey] ?? 0) + 1;
    this.saveSafety({
      connectivity: "DEGRADED",
      generation: s.generation + 1,
      resumePending: s.resumePending || (r.running && !r.error && !r.emergency),
      episodeAt: s.episodeAt ?? now,
      lastFailureAt: now,
      latestFailure: failure,
      failures: s.failures + 1,
      episodeTally: tally,
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
  /**
   * A STALE_CANDLES throw out of candle validation during an
   * active tick is the same condition the watchdog reports as a
   * CANDLE_STALE stall; which entrance fires first is a cadence
   * race (the 2026-11-07 evening validation run hard-stopped
   * through this entrance, before the watchdog's boundary, so
   * the stale episode limits never applied). Route the throw
   * into the stall machinery so both entrances share one policy.
   * A bot paused inside an open recovery episode is routed too:
   * its ticks are the recovery proofs, so a stale reading there
   * is the same episode continuing, not a new failure (until the
   * controller tolerated pauses in 2026-11-08, the first recovery
   * tick hard-stopped every candle-stale pause within seconds).
   * A plain stop without a pending resume, a latched error, and
   * an emergency are never softened.
   */
  staleThrowToStall(code: string, now = Date.now()): boolean {
    if (code !== "STALE_CANDLES") return false;
    const r = this.db.runtime();
    if (r.error || r.emergency) return false;
    if (!r.running && !this.safety().resumePending) return false;
    const details = this.stallDetails(now);
    if (!details || details.reasonDetail !== "CANDLE_STALE") return false;
    this.stallFailure(details, now);
    return true;
  }
  /**
   * A successfully read order book can fail a trading gate
   * (spread too wide, too thin, stale, malformed). That is a
   * property of the current book, not a transport failure, so
   * no ApiFailure is recorded and transientCycleFailure never
   * sees it; until now the throw fell through to failCycle and
   * hard-stopped on a single reading (the 2026-11-09 24h
   * validation run died on one wide spread in the thin
   * early-morning book). Route the throw into the same recovery
   * episode as a stall: the gate itself already prevents any
   * trade on a bad book, so pausing loses nothing, and a book
   * that stays bad escalates via the episode limits (a
   * book-guard-only episode earns the long window: see
   * slowMarketTallyKeys in paper-recovery).
   * A bot paused inside an open recovery episode is routed too:
   * its ticks are the recovery proofs, so a bad book there is
   * the same episode continuing, not a new failure. A plain stop
   * without a pending resume, a latched error, and an emergency
   * are never softened. Pair mismatch and source changes are
   * identity problems, not transients, and keep hard-stopping,
   * as do the candle guards.
   */
  bookGuardThrowToEpisode(code: string, now = Date.now()): boolean {
    if (
      ![
        "SPREAD_TOO_WIDE",
        "THIN_ORDERBOOK",
        "STALE_ORDERBOOK",
        "INVALID_ORDERBOOK",
      ].includes(code)
    )
      return false;
    const r = this.db.runtime();
    if (r.error || r.emergency) return false;
    if (!r.running && !this.safety().resumePending) return false;
    this.episodeFailure(code, `MarketData/${code}`, now);
    return true;
  }
  checkRecoveryDeadline(now = Date.now()) {
    const s = this.safety();
    const limits = episodeLimits(s);
    if (
      s.resumePending &&
      ((s.episodeAt != null &&
        now - s.episodeAt >= limits.maxEpisodeMs) ||
        s.failures >= limits.maxFailures)
    )
      this.stop("PAPER_RECOVERY_EXHAUSTED", now);
  }
  ordersAllowed(generation?: number, now = Date.now()) {
    if (this.shutdownRequested || this.recoveryReadFault) return false;
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
    if (this.shutdownRequested || this.recoveryReadFault) return false;
    try {
      // Hold the write lock through identity/ledger checks and the resume write.
      return this.db.transaction(() => this.checkedRecoveryCycle(checks, now));
    } catch {
      this.recoveryReadFault = true;
      try {
        this.failCycle("PAPER_RECOVERY_READ_FAILED", now);
      } catch {
        /* Process-local gate remains closed. */
      }
      return false;
    }
  }
  private checkedRecoveryCycle(
    checks: { market: boolean; sui: boolean },
    now: number,
  ) {
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
    if (!checks.market || !checks.sui || apiAccess.blocked()) {
      this.saveSafety({
        connectivity: "DEGRADED",
        healthyCycles: 0,
        firstHealthyAt: null,
        lastHealthyCycleAt: null,
      });
      return false;
    }
    if (!this.recoveryOrdersKnown(now)) {
      this.failCycle("PAPER_ORDER_STATE_UNKNOWN", now);
      return false;
    }
    if (!this.ledger().ok) {
      this.failCycle("PAPER_RECONCILIATION_FAILED", now);
      return false;
    }
    const stalled = this.stallDetails(now);
    if (stalled) {
      this.stallFailure(stalled, now);
      return false;
    }
    const finalSafety = this.safety(),
      finalRuntime = this.db.runtime();
    if (
      !this.db.health().healthy ||
      finalSafety.generation !== s.generation ||
      finalRuntime.error ||
      finalRuntime.emergency ||
      this.cycleFailed ||
      this.softFailureThisCycle
    )
      return false;
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
      finalSafety.resumePending &&
      !this.db.runtime().error &&
      !r.emergency &&
      this.mode === "PAPER";
    const episode = episodeSummaryOf(s, now, "RECOVERED") ?? undefined;
    this.saveSafety({
      connectivity: "HEALTHY",
      healthyCycles: count,
      firstHealthyAt: first,
      lastHealthyCycleAt: now,
      episodeAt: null,
      failures: 0,
      episodeTally: {},
      resumePending: false,
      recoveredAt: resume ? now : null,
    });
    if (resume) {
      this.db.set("runtime", { ...this.db.runtime(), running: true });
      this.transition(
        "PAPER_NETWORK_RECOVERED",
        now,
        undefined,
        {
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
        },
        episode,
      );
    }
    return resume;
  }

  /** PAPER fills are atomic; pending/unknown or unmatched records require operator review. */
  private recoveryOrdersKnown(now: number) {
    const orders = new Map<
      string,
      { status: string; side: unknown; trades: number; checks: number }
    >();
    let known = true;
    this.db.visitRecoveryRecords((table, row) => {
      const value = JSON.parse(row.json);
      if (
        !value ||
        typeof value !== "object" ||
        !Number.isFinite(row.timestamp) ||
        row.timestamp < 0 ||
        row.timestamp > now
      ) {
        known = false;
        return;
      }
      const id = table === "paper_orders" ? value.id : value.orderId;
      if (typeof id !== "string" || !id.length || row.id !== id) {
        known = false;
        return;
      }
      if (table === "paper_orders") {
        if (orders.has(id) || !["FILLED", "REJECTED"].includes(value.status))
          known = false;
        orders.set(id, {
          status: value.status,
          side: value.side,
          trades: 0,
          checks: 0,
        });
      } else {
        const order = orders.get(id);
        if (!order || order.status !== "FILLED") {
          known = false;
          return;
        }
        if (table === "paper_trades") {
          if (
            !["BUY", "SELL"].includes(value.side) ||
            value.side !== order.side
          )
            known = false;
          order.trades++;
        } else {
          if (value.ok !== true) known = false;
          order.checks++;
        }
      }
    });
    for (const order of orders.values())
      if (
        order.status !== "REJECTED" &&
        (order.trades !== 1 || order.checks !== 1)
      )
        known = false;
    return known;
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
      indexerLatency: null,
      ...this.db.get<OperationState>("operation_state")!,
    };
  }
  /** Merge one drained batch of DeepBook Indexer latency
   * telemetry into the persisted aggregate in operation_state.
   * Network durations fold into each kind's count / max /
   * recent ring; TTL cache hits only raise the kind's cached
   * counter, so they never enter the distribution. Recording
   * only: the aggregate is bounded (a capped recent ring per
   * kind) and is never read by any trading or safety
   * decision. */
  recordIndexerLatencySamples(drain: {
    samples?: Partial<Record<IndexerLatencyKind, number[]>>;
    cached?: Partial<Record<IndexerLatencyKind, number>>;
  }) {
    const empty = (): IndexerLatencyBucket => ({
      count: 0,
      maxMs: 0,
      recent: [],
      cached: 0,
    });
    const current = this.state().indexerLatency;
    const next: IndexerLatencyAggregate = {
      candles: current?.candles ?? empty(),
      book: current?.book ?? empty(),
      status: current?.status ?? empty(),
      other: current?.other ?? empty(),
    };
    let changed = false;
    for (const kind of indexerLatencyKinds) {
      const bucket: IndexerLatencyBucket = {
        count: next[kind].count,
        maxMs: next[kind].maxMs,
        recent: [...next[kind].recent],
        // Aggregates persisted before the split have no
        // cached counter; it starts at zero.
        cached: next[kind].cached ?? 0,
      };
      for (const ms of drain.samples?.[kind] ?? []) {
        if (!Number.isFinite(ms) || ms < 0) continue;
        bucket.count += 1;
        bucket.maxMs = Math.max(bucket.maxMs, ms);
        bucket.recent.push(ms);
        changed = true;
      }
      if (bucket.recent.length > 60)
        bucket.recent.splice(0, bucket.recent.length - 60);
      const hits = drain.cached?.[kind] ?? 0;
      if (Number.isInteger(hits) && hits > 0) {
        bucket.cached = (bucket.cached ?? 0) + hits;
        changed = true;
      }
      next[kind] = bucket;
    }
    if (changed) this.update({ indexerLatency: next });
  }
  /** Display summary of the persisted indexer latency
   * aggregate: network sample count, median of the recent
   * window, the all-time max and the TTL cache-hit count,
   * per read class. */
  indexerLatencySummary() {
    const aggregate = this.state().indexerLatency;
    const summarize = (bucket: IndexerLatencyBucket | undefined) => {
      if (!bucket || (bucket.count <= 0 && (bucket.cached ?? 0) <= 0))
        return null;
      const sorted = [...bucket.recent].sort((a, b) => a - b);
      return {
        count: bucket.count,
        medianMs: sorted.length
          ? Math.round(sorted[Math.floor(sorted.length / 2)])
          : null,
        maxMs: Math.round(bucket.maxMs),
        cached: bucket.cached ?? 0,
      };
    };
    return {
      candles: summarize(aggregate?.candles),
      book: summarize(aggregate?.book),
      status: summarize(aggregate?.status),
      other: summarize(aggregate?.other),
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
    episode?: EpisodeSummary,
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
        ...(episode ? { episode } : {}),
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
    const episode =
      episodeSummaryOf(this.safety(), now, "INTERRUPTED") ?? undefined;
    this.saveSafety({
      ...initialPaperSafety(),
      generation: this.safety().generation + 1,
      lastStopReason: this.safety().lastStopReason,
    });
    this.db.set("runtime", { ...this.db.runtime(), running: false });
    this.db.interruptPending(now);
    this.event(
      "BOOT",
      "PROCESS_RESTART_STOPPED",
      now,
      false,
      undefined,
      undefined,
      episode,
    );
  }
  transition(
    reason: string,
    now = Date.now(),
    details?: MarketStallDetails,
    recoveryProof?: PaperRecoveryProof,
    episode?: EpisodeSummary,
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
      episode,
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
      if (details) this.stallFailure(details, Date.now());
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
        if (details) this.stallFailure(details, Date.now());
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
      indexerLatency: this.indexerLatencySummary(),
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
      if (this.isShutdownCancellation(error)) {
        this.event("ANOMALY", "PROCESS_SHUTDOWN_CANCELLED");
        throw error;
      }
      this.cycleFailed = true;
      const reason = safeFailure(error);
      // A successfully read book can fail a trading gate. That is not a
      // transport failure and must not trip CONSECUTIVE_API_ERRORS.
      const marketGuard =
        kind === "MARKET" &&
        [
          "THIN_ORDERBOOK",
          "SPREAD_TOO_WIDE",
          "STALE_ORDERBOOK",
          "INVALID_ORDERBOOK",
          "MARKET_PAIR_MISMATCH",
          "MARKET_SOURCE_CHANGED",
          "INSUFFICIENT_CANDLES",
          "INVALID_CANDLE",
          "CANDLE_GAP",
          "PRICE_OUTLIER",
          "STALE_CANDLES",
        ].includes(reason);
      const s = this.state();
      if (!marketGuard)
        this.update({
          apiErrors: s.apiErrors + 1,
          consecutiveErrors: s.consecutiveErrors + 1,
        });
      this.event("ERROR", `${kind}_${reason}`);
      if (
        !marketGuard &&
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
    const r = this.db.runtime();
    const episode =
      episodeSummaryOf(
        this.safety(),
        now,
        reason === "PAPER_RECOVERY_EXHAUSTED" ? "EXHAUSTED" : "STOPPED",
      ) ?? undefined;
    this.saveSafety({
      resumePending: false,
      generation: this.safety().generation + 1,
      lastStopReason: r.error ?? code(reason),
      recoveredAt: null,
    });
    if (r.running || !r.error) {
      this.db.set("runtime", {
        ...r,
        running: false,
        error: r.error ?? code(reason),
      });
      this.transition(reason, now, details, undefined, episode);
      if (details)
        console.warn(
          JSON.stringify({ event: "MARKET_DATA_STALLED", ...details }),
        );
    }
  }
  failCycle(reason: string, now = Date.now(), details?: MarketStallDetails) {
    const runtime = this.db.runtime();
    const alreadyStopped = !runtime.running && !!runtime.error;
    if (!this.cycleFailed) this.event("ERROR", reason, now, false, details);
    this.cycleFailed = true;
    // Keep failed polling evidence without presenting every poll as a new stop.
    this.event("ANOMALY", reason, now, !alreadyStopped, details);
    this.stop(reason, now, details);
  }
  /**
   * A market-data stall used to latch an immediate safety stop.
   * It now enters the same recovery episode as a transient read
   * failure: trading pauses (DEGRADED, resume pending) and the
   * monitor resumes only after the usual healthy proofs; a stall
   * that persists escalates via checkRecoveryDeadline to
   * PAPER_RECOVERY_EXHAUSTED (a pure candle-stale episode gets
   * the longer stale deadline from episodeLimits). An existing
   * hard stop or emergency
   * is never softened into a pause, and a manually stopped bot
   * is left alone.
   */
  stallFailure(details: MarketStallDetails, now = Date.now()) {
    this.episodeFailure(
      "MARKET_DATA_STALLED",
      `MarketData/${details.reasonDetail}`,
      now,
      details,
    );
  }
  /**
   * The accounting shared by every transient market-data entrance
   * (watchdog stall, stale-candle throw, order-book guard throw):
   * count the failure into the open recovery episode (at most one
   * count per 30 s), pause trading, and let checkRecoveryDeadline
   * escalate a persistent episode to PAPER_RECOVERY_EXHAUSTED.
   * An existing hard stop or emergency is never softened into a
   * pause, and a manually stopped bot is left alone.
   */
  private episodeFailure(
    eventCode: string,
    tallyKey: string,
    now: number,
    details?: MarketStallDetails,
  ) {
    const r = this.db.runtime(),
      s = this.safety();
    if (!this.cycleFailed)
      this.event("ERROR", eventCode, now, false, details);
    this.cycleFailed = true;
    if (r.emergency || r.error || (!r.running && !s.resumePending)) {
      this.event("ANOMALY", eventCode, now, false, details);
      return;
    }
    const entering = s.connectivity === "HEALTHY",
      recentlyCounted =
        s.episodeAt != null &&
        s.lastFailureAt != null &&
        now - s.lastFailureAt < 30000;
    if (recentlyCounted) {
      this.checkRecoveryDeadline(now);
      return;
    }
    this.event("ANOMALY", eventCode, now, entering, details);
    if (details)
      console.warn(JSON.stringify({ event: eventCode, ...details }));
    const tally = { ...(s.episodeAt == null ? {} : s.episodeTally) };
    tally[tallyKey] = (tally[tallyKey] ?? 0) + 1;
    this.saveSafety({
      connectivity: "DEGRADED",
      generation: entering ? s.generation + 1 : s.generation,
      resumePending: true,
      episodeAt: s.episodeAt ?? now,
      lastFailureAt: now,
      failures: s.failures + 1,
      episodeTally: tally,
      healthyCycles: 0,
      firstHealthyAt: null,
      lastHealthyCycleAt: null,
      recoveredAt: null,
    });
    this.db.set("runtime", { ...r, running: false });
    if (r.running) this.transition("PAPER_NETWORK_PAUSED", now);
    this.checkRecoveryDeadline(now);
  }
  watchdog(now = Date.now()) {
    this.db.assertHealthy();
    const details = this.stallDetails(now);
    this.checkRecoveryDeadline(now);
    if (details) this.stallFailure(details, now);
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
    return computeLedger(this.db, now);
  }
  totals(trades: Fill[]) {
    return computeTotals(trades);
  }
  report(hours: 24 | 168, now = Date.now()) {
    return computeReport(this.db, this.state(), hours, now);
  }
  safetySnapshot(now = Date.now()) {
    const r = this.db.runtime();
    return {
      ...this.safety(),
      // Display evidence only; ordersAllowed retains the acquisition gate.
      marketUpdating: this.fetchMono !== null,
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
    return readDisplayDecision(this.db);
  }
  decisionTelemetry(now = Date.now()): DecisionTelemetry | null {
    return buildDecisionTelemetry(this.displayDecision(), now);
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
      workerBuild: workerBuild(),
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
