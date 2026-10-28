import {
  paperRecoveryLimits,
  type PaperSafetyState,
} from "../../../packages/shared/src/paper-recovery.ts";
import { validateCandles } from "../../../packages/market-data/src/validation.ts";
import { digest, type RuntimeBuild } from "./runtime-build.ts";
import { randomUUID } from "node:crypto";
import { BotDatabase } from "../../../packages/database/src/index.ts";
import type { ApiAttempt } from "../../../packages/shared/src/api.ts";
import type {
  Candle,
  CycleEvidence,
  CandleProvenance,
} from "../../../packages/shared/src/index.ts";
import type {
  MarketStatus,
  Frames,
} from "../../../packages/market-data/src/provider.ts";
import type {
  OperationEvent,
  OperationState,
} from "../../../packages/shared/src/operations.ts";
export const validationLimits = {
  durationMs: 86400000,
  heartbeatMs: 15000,
  maxGapMs: 45000,
  apiSuccessRate: 0.99,
  maxBookAgeMs: 10000,
  maxIndexerLagMs: 60000,
  maxReconstructionMs: 45000,
};
export function assertValidationProfile(env: NodeJS.ProcessEnv) {
  if (env.DEEPBOOK_VALIDATION !== "1") return false;
  if (
    env.MODE !== "PAPER" ||
    env.MARKET_DATA_PROVIDER !== "deepbook" ||
    env.DEEPBOOK_RECONSTRUCT_CANDLES !== "verified" ||
    !env.DATABASE_PATH?.replaceAll("\\", "/").endsWith(
      "/validation/deepbook-paper.sqlite",
    )
  )
    throw Error("INVALID_VALIDATION_PROFILE");
  return true;
}
export interface ValidationSession {
  build?: (RuntimeBuild & { settingsSha256: string }) | null;
  id: string;
  startedAt: number;
  targetAt: number;
  initialRunningMs: number;
  initialEquity: number | null;
  intervalMs: number;
}
interface Sample {
  safety?: PaperSafetyState;
  timing?: Partial<OperationState> | null;
  kind: "sample";
  at: number;
  running: boolean;
  emergency: boolean;
  error: string | null;
  runningMs: number;
  profitGuard: boolean;
  intervalMs: number;
  equity: number | null;
  market: MarketStatus | null;
}
interface Cycle {
  execution?: CycleEvidence;
  timing?: Partial<OperationState> | null;
  kind: "cycle";
  at: number;
  durationMs: number;
  error: string | null;
  action: string | null;
  market: MarketStatus | null;
  bars: number;
  timestamps: number[];
  repairs: { timestamp: number; provenance: CandleProvenance }[];
}
export interface ValidationFill {
  safety?: PaperSafetyState;
  kind: "fill";
  at: number;
  sessionId: string;
  mode: "PAPER";
  market: MarketStatus | null;
  source: string;
  candleClosedAt: number;
  candles: Candle[];
  quoteExpiresAt: number;
  maxSpread: number;
  maxOrder: number;
  riskAllowed: boolean;
  profitGuard: boolean;
  profitAllowed: boolean;
  running: boolean;
}
type Event =
  | Sample
  | Cycle
  | ValidationFill
  | { kind: "api"; at: number; data: ApiAttempt; safelyStopped: boolean };
const pct = (n: number, d: number) => (d ? n / d : null);
const stats = (values: number[]) => {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: a.length,
    averageMs: a.length ? a.reduce((a, b) => a + b, 0) / a.length : null,
    p95Ms: a.length ? a[Math.ceil(a.length * 0.95) - 1] : null,
    maxMs: a.at(-1) ?? null,
  };
};
const quantities = (values: number[]) => {
  const s = stats(values);
  return { count: s.count, mean: s.averageMs, p95: s.p95Ms, max: s.maxMs };
};
export class ValidationRecorder {
  private cached: {
    at: number;
    version: string;
    value: ValidationReport;
  } | null = null;
  private inputs: {
    key: string;
    rows: { timestamp: number; json: string }[];
    values: Event[];
    upper?: number;
    selected?: Event[];
  } | null = null;
  private readEvents(session: ValidationSession, now: number, version: string) {
    const key = JSON.stringify([version, session]);
    if (this.inputs?.key !== key) {
      const rows = this.db.displayValidationRows(
        session.startedAt,
        session.targetAt + validationLimits.maxGapMs,
      );
      this.inputs = { key, rows, values: [] };
    }
    const c = this.inputs,
      until = Math.min(now, session.targetAt + validationLimits.maxGapMs);
    let lo = 0,
      hi = c.rows.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (c.rows[mid].timestamp <= until) lo = mid + 1;
      else hi = mid;
    }
    if (c.upper !== lo) {
      // Preserve parsing failures only within the original SQL time window.
      while (c.values.length < lo)
        c.values.push(JSON.parse(c.rows[c.values.length].json));
      c.upper = lo;
      c.selected = c.values.slice(0, lo);
    }
    return c.selected!;
  }
  private pendingFault: string | null = null;
  constructor(readonly db: BotDatabase) {}
  boot() {
    const recorded = this.session()?.build;
    const actual = this.db.get<RuntimeBuild>("runtime_build");
    if (
      recorded &&
      (!actual ||
        ["declaredSha", "declaredImage", "node", "lockSha256"].some(
          (key) =>
            recorded[key as keyof RuntimeBuild] !==
            actual[key as keyof RuntimeBuild],
        ))
    )
      this.fault("EXECUTION_BUILD_CHANGED");
    if (this.session() && this.db.get("validation_clean_shutdown") === false)
      this.fault("UNCLEAN_RESTART");
    this.db.set("validation_clean_shutdown", false);
  }
  fault(code: string) {
    this.cached = null;
    this.pendingFault = code;
    this.db.set("validation_integrity_fault", code);
  }
  closed() {
    this.db.set("validation_clean_shutdown", true);
  }

  session() {
    return this.db.get<ValidationSession>("validation_session") ?? null;
  }
  private runningMs(now: number) {
    const s = this.db.get<OperationState>("operation_state");
    return s
      ? s.runningMs +
          (s.active
            ? Math.max(0, Math.min(now, s.lastHeartbeatAt) - s.accountedAt)
            : 0)
      : 0;
  }
  begin(now = Date.now()) {
    if (this.session()) throw Error("VALIDATION_ALREADY_STARTED");
    if (this.db.runtime().running) throw Error("STOP_BEFORE_VALIDATION");
    if (!this.db.settings().profitGuardEnabled)
      throw Error("PROFIT_GUARD_REQUIRED");
    const price = this.db.get<number>("price"),
      p = this.db.portfolio();
    const session: ValidationSession = {
      build: this.db.get<RuntimeBuild>("runtime_build")
        ? {
            ...this.db.get<RuntimeBuild>("runtime_build")!,
            settingsSha256: digest(JSON.stringify(this.db.settings())),
          }
        : null,
      id: randomUUID(),
      startedAt: now,
      targetAt: now + validationLimits.durationMs,
      initialRunningMs: this.runningMs(now),
      initialEquity:
        p.sui === 0 ? p.usdc : price ? p.usdc + p.sui * price : null,
      intervalMs: this.db.settings().intervalMs,
    };
    this.db.set("validation_session", session);
    this.cached = null;
    this.sample(null, now);
    return this.report(now);
  }
  private append(event: Event) {
    const s = this.session();
    if (
      !s ||
      event.at < s.startedAt ||
      event.at > s.targetAt + validationLimits.maxGapMs
    )
      return;
    if (this.pendingFault)
      this.db.set("validation_integrity_fault", this.pendingFault);
    this.db.append("validation_events", randomUUID(), event, event.at);
  }
  attempt(data: ApiAttempt) {
    const r = this.db.runtime();
    this.append({
      kind: "api",
      at: data.occurredAt,
      data,
      safelyStopped:
        !r.running &&
        !!(
          r.error ||
          r.emergency ||
          (this.db.get<PaperSafetyState>("paper_safety")?.connectivity !==
            undefined &&
            this.db.get<PaperSafetyState>("paper_safety")?.connectivity !==
              "HEALTHY")
        ),
    });
  }
  cycle(
    market: MarketStatus | null,
    frames: Frames,
    action: string | null,
    error: string | null,
    began: number,
    now = Date.now(),
    execution?: CycleEvidence,
  ) {
    const rows = frames[300] ?? [];
    this.append({
      kind: "cycle",
      execution,
      timing: this.db.get<OperationState>("operation_state") ?? null,
      at: now,
      durationMs: now - began,
      market,
      error,
      action,
      bars: rows.length,
      timestamps: rows.map((x) => x.timestamp),
      repairs: rows
        .filter((x) => x.provenance && x.provenance.origin !== "ORIGINAL")
        .map((x) => ({ timestamp: x.timestamp, provenance: x.provenance! })),
    });
  }
  sample(market: MarketStatus | null, now = Date.now()) {
    const r = this.db.runtime(),
      s = this.db.settings(),
      p = this.db.portfolio(),
      price = this.db.get<number>("price");
    this.append({
      kind: "sample",
      safety: this.db.get<PaperSafetyState>("paper_safety"),
      timing: this.db.get<OperationState>("operation_state") ?? null,
      at: now,
      running: r.running,
      emergency: r.emergency,
      error: r.error,
      runningMs: this.runningMs(now),
      profitGuard: s.profitGuardEnabled,
      intervalMs: s.intervalMs,
      equity: p.sui === 0 ? p.usdc : price ? p.usdc + p.sui * price : null,
      market,
    });
  }
  fill(
    market: MarketStatus | null,
    source: string,
    candles: Candle[],
    quoteExpiresAt: number,
    riskAllowed: boolean,
    profitAllowed: boolean,
    now = Date.now(),
  ): ValidationFill | undefined {
    const session = this.session();
    if (!session || now > session.targetAt) return;
    const s = this.db.settings(),
      r = this.db.runtime(),
      last = candles.at(-1)!;
    return {
      kind: "fill",
      safety: this.db.get<PaperSafetyState>("paper_safety"),
      at: now,
      sessionId: session.id,
      mode: "PAPER",
      market,
      source,
      candleClosedAt: (last.timestamp + 300) * 1000,
      candles,
      quoteExpiresAt,
      maxSpread: s.maxSlippage,
      maxOrder: s.maxOrder,
      riskAllowed,
      profitGuard: s.profitGuardEnabled,
      profitAllowed,
      running: r.running && !r.emergency && !r.error,
    };
  }
  report(now = Date.now(), fresh = false): ValidationReport {
    const version = this.db.displayVersion();
    if (
      !fresh &&
      this.cached &&
      this.cached.version === version &&
      now >= this.cached.at &&
      now - this.cached.at < 10000
    )
      return this.cached.value;
    const session = this.session();
    const value = aggregateValidation(
      this.db,
      session,
      now,
      session ? this.readEvents(session, now, version) : undefined,
    );
    const result = value;
    this.cached = { at: now, version, value: result };
    return result;
  }
}
const summaries = new WeakMap<Event[], ReturnType<typeof summarizeEvents>>();
function summarizeEvents(events: Event[]) {
  const cycles = events.filter((e): e is Cycle => e.kind === "cycle");
  const api = events
    .filter((e): e is Extract<Event, { kind: "api" }> => e.kind === "api")
    .map((e) => ({ ...e.data, safelyStopped: e.safelyStopped }));
  const fills = events.filter((e): e is ValidationFill => e.kind === "fill");
  const apis = [...new Set(api.map((a) => a.api))].map((name) => {
    const a = api.filter((x) => x.api === name),
      codes: Record<string, number> = {};
    for (const x of a) if (x.code) codes[x.code] = (codes[x.code] ?? 0) + 1;
    return {
      api: name,
      requests: a.length,
      successes: a.filter((x) => x.success).length,
      successRate: pct(a.filter((x) => x.success).length, a.length),
      retries: a.filter((x) => x.attempt > 0).length,
      failures: a.filter((x) => !x.success).length,
      codes,
      lastSuccessAt: a.filter((x) => x.success).at(-1)?.occurredAt ?? null,
      latency: stats(a.map((x) => x.latencyMs)),
    };
  });
  const resolved = new Set<number>();
  const gaps = new Set<number>(),
    repaired = new Map<number, Cycle["repairs"][number]>(),
    seen = new Set<number>();
  let reconstructionFailures = 0,
    latestQuality: MarketStatus["quality"] | undefined;
  const currentQualities: NonNullable<MarketStatus["quality"]>[number][] = [];
  let currentUnresolved: number[] = [];
  for (const c of cycles) {
    const snapshot = c.market?.quality?.[300];
    // An upstream health failure may expose an older provider snapshot.
    const q =
      snapshot && snapshot.fetchedAt >= c.at - c.durationMs
        ? snapshot
        : undefined;
    if (q) {
      latestQuality = c.market?.quality;
      for (const t of q.gapTimestamps ?? []) {
        gaps.add(t);
      }
      if (q.unresolved > 0) {
        reconstructionFailures++;
        // Reopen only a gap actually observed unresolved in this acquisition.
        for (const t of q.unresolvedTimestamps ?? q.gapTimestamps ?? [])
          if (!c.timestamps.includes(t)) resolved.delete(t);
      }
      currentQualities.push(q);
      currentUnresolved =
        q.unresolved === 0
          ? []
          : (q.unresolvedTimestamps ??
            (q.gapTimestamps ?? []).filter((t) => !c.timestamps.includes(t)));
    }
    for (const t of c.timestamps) {
      seen.add(t);
      resolved.add(t);
    }
    for (const r of c.repairs) repaired.set(r.timestamp, r);
  }
  const historicalUnresolved = [...gaps].filter((t) => !resolved.has(t));
  const unresolved = currentUnresolved;
  const qualities = currentQualities;
  const actions = { BUY: 0, SELL: 0, WAIT: 0 };
  for (const c of cycles)
    if (c.action && c.action in actions)
      actions[c.action as keyof typeof actions]++;
  const candles = {
    uniqueFiveMinuteBars: seen.size,
    originalMissing: gaps.size,
    reconstructed: repaired.size,
    restoredOriginal: [...gaps].filter(
      (t) => resolved.has(t) && !repaired.has(t),
    ).length,
    reconstructionFailures,
    failedCandleObservations: qualities.reduce((n, q) => n + q.unresolved, 0),
    latestRawCount: latestQuality?.[300]?.originalCount ?? null,
    unresolved: latestQuality?.[300]?.unresolved ?? null,
    historicalUnresolved: historicalUnresolved.length,
    historicalUnresolvedTimestamps: historicalUnresolved,
    qualityObservedAt: latestQuality?.[300]?.fetchedAt ?? null,
    unresolvedTimestamps: unresolved,
    missingRate: pct(gaps.size, seen.size + historicalUnresolved.length),
    reconstructionSuccessRate: pct(repaired.size, gaps.size),
    latestQuality: latestQuality ?? null,
    reconstructionTime: stats(qualities.map((q) => q.reconstructionMs ?? 0)),
    evidence: [...repaired.values()],
  };
  const book = {
    ageMs: stats(
      cycles
        .filter((c) => c.market?.bookAt != null)
        .map((c) => c.at - c.market!.bookAt!),
    ),
    spread: quantities(
      cycles.flatMap((c) =>
        c.market?.spread == null ? [] : [c.market.spread],
      ),
    ),
    bidDepthUsdc: quantities(
      cycles.flatMap((c) =>
        c.market?.diagnostics?.bidDepthUsdc == null
          ? []
          : [c.market.diagnostics.bidDepthUsdc],
      ),
    ),
    askDepthUsdc: quantities(
      cycles.flatMap((c) =>
        c.market?.diagnostics?.askDepthUsdc == null
          ? []
          : [c.market.diagnostics.askDepthUsdc],
      ),
    ),
    indexerLagMs: stats(
      cycles.flatMap((c) =>
        c.market?.diagnostics?.indexerLagMs == null
          ? []
          : [c.market.diagnostics.indexerLagMs],
      ),
    ),
  };
  return {
    cycles,
    api,
    fills,
    apis,
    candles,
    book,
    actions,
    qualities,
    unresolved,
    latestQuality,
  };
}
function eventSummary(events: Event[]) {
  let result = summaries.get(events);
  if (!result) {
    result = summarizeEvents(events);
    summaries.set(events, result);
  }
  return result;
}
export function aggregateValidation(
  db: BotDatabase,
  session: ValidationSession | null,
  now: number,
  inputEvents?: Event[],
) {
  const limits = validationLimits;
  const pair = db.portfolio().baseCoin?.includes("::wal::WAL")
    ? ("WAL_USDC" as const)
    : ("SUI_USDC" as const);
  if (!session)
    return {
      pair,
      status: "未開始" as string,
      session: null,
      generatedAt: now,
      limits,
    };
  const end = Math.min(now, session.targetAt),
    elapsedMs = Math.max(0, end - session.startedAt);
  const all =
    inputEvents ??
    db.range<Event>(
      "validation_events",
      session.startedAt,
      Math.min(now, session.targetAt + limits.maxGapMs),
    );
  const events = all.every((x) => x.at <= end)
    ? all
    : all.filter((x) => x.at <= end);
  const samples = all.filter((e): e is Sample => e.kind === "sample");
  const derived = eventSummary(events);
  const {
    cycles,
    api,
    fills,
    apis,
    actions,
    qualities,
    unresolved,
    latestQuality,
  } = derived;
  const operations = db.range<OperationEvent>(
    "operation_events",
    session.startedAt,
    end,
  );
  const orders = db.range<unknown>("paper_trades", session.startedAt, end);
  const orderRequests = db.range<{ status?: string }>(
    "paper_orders",
    session.startedAt,
    end,
  );
  const checks = db.range<{ ok: boolean }>(
    "paper_checks",
    session.startedAt,
    end,
  );
  const windowSamples = samples.filter((s) => s.at <= end);
  const latest = windowSamples.at(-1) ?? null;
  let maxGapMs = 0,
    cursor = session.startedAt;
  for (const s of samples) {
    maxGapMs = Math.max(maxGapMs, Math.min(end, s.at) - cursor);
    cursor = Math.min(end, s.at);
  }
  maxGapMs = Math.max(maxGapMs, end - cursor);
  const stops = operations.filter(
    (x) =>
      x.kind === "STOP" &&
      !["MANUAL_STOP", "PROCESS_SHUTDOWN"].includes(x.code),
  );
  const starts = operations.filter((x) => x.code === "MANUAL_START");
  const stopped = operations.filter(
    (x) => x.kind === "STOP" || x.kind === "BOOT",
  );
  const guardedRecoveries = operations.filter((e) => {
    const p = e.recoveryProof;
    return (
      e.kind === "CONTROL" &&
      e.code === "PAPER_NETWORK_RECOVERED" &&
      !!p &&
      p.mode === "PAPER" &&
      p.confirmedAt === e.timestamp &&
      p.healthyCycles >= paperRecoveryLimits.healthyCycles &&
      p.firstHealthyAt > p.lastFailureAt &&
      p.confirmedAt - p.firstHealthyAt >=
        paperRecoveryLimits.minimumHealthyMs &&
      p.marketHealthy === true &&
      p.suiHealthy === true &&
      p.ledgerHealthy === true &&
      p.backoff === false
    );
  });
  const unauthorizedRuns = windowSamples.filter(
    (s) =>
      s.running &&
      (!starts.some((x) => x.timestamp <= s.at) ||
        stopped.some(
          (stop) =>
            stop.timestamp < s.at &&
            !starts.some(
              (start) =>
                start.timestamp >= stop.timestamp && start.timestamp <= s.at,
            ) &&
            !(
              stop.code === "PAPER_NETWORK_PAUSED" &&
              !s.emergency &&
              !s.error &&
              s.safety?.connectivity === "HEALTHY" &&
              guardedRecoveries.some(
                (e) =>
                  e.timestamp >= stop.timestamp &&
                  e.timestamp <= s.at &&
                  e.recoveryProof!.lastFailureAt >= stop.timestamp &&
                  e.recoveryProof!.generation === s.safety?.generation,
              )
            ),
        )),
  );
  const validPrices = (f: ValidationFill) => {
    try {
      validateCandles(f.candles, 300, f.at);
      return f.candles.every((c) => c.source === f.source);
    } catch {
      return false;
    }
  };
  const unsafeFills = fills.filter(
    (f) =>
      !validPrices(f) ||
      !f.running ||
      (!!f.safety && f.safety.connectivity !== "HEALTHY") ||
      f.mode !== "PAPER" ||
      !f.source.startsWith(
        `DeepBook:${db.portfolio().baseCoin?.includes("::wal::WAL") ? "WAL_USDC" : "SUI_USDC"}:USDC:verified-v1`,
      ) ||
      !f.market?.healthy ||
      f.market.source !== "DeepBook" ||
      !f.market.quality?.[300] ||
      f.market.quality[300].unresolved !== 0 ||
      f.market.bookAt == null ||
      f.at - f.market.bookAt > limits.maxBookAgeMs ||
      f.market.bookAt > f.at + 5000 ||
      f.quoteExpiresAt <= f.at ||
      f.at - f.candleClosedAt > 360000 ||
      f.candleClosedAt > f.at ||
      f.market.spread == null ||
      f.market.spread <= 0 ||
      f.market.spread > f.maxSpread ||
      f.market.diagnostics?.bidDepthUsdc == null ||
      f.market.diagnostics.bidDepthUsdc < f.maxOrder ||
      f.market.diagnostics.askDepthUsdc == null ||
      f.market.diagnostics.askDepthUsdc < f.maxOrder ||
      f.market.diagnostics.indexerLagMs == null ||
      f.market.diagnostics.indexerLagMs < 0 ||
      f.market.diagnostics.indexerLagMs > limits.maxIndexerLagMs ||
      !f.riskAllowed ||
      !f.profitGuard ||
      !f.profitAllowed,
  );
  const failureApis = api.filter(
    (x) =>
      !x.success &&
      [
        "UPSTREAM_TIMEOUT",
        "UPSTREAM_CONNECT_TIMEOUT",
        "UPSTREAM_HEADERS_TIMEOUT",
        "UPSTREAM_BODY_TIMEOUT",
        "UPSTREAM_NETWORK_FAILED",
        "UPSTREAM_DNS_FAILED",
        "UPSTREAM_HTTP_429",
        "UPSTREAM_HTTP_502",
        "UPSTREAM_HTTP_503",
        "UPSTREAM_HTTP_504",
      ].includes(x.code ?? ""),
  );
  const missingSafetyStops = failureApis.filter(
    (a) =>
      !a.safelyStopped &&
      !operations.some(
        (o) =>
          o.kind === "STOP" &&
          o.timestamp >= a.occurredAt - 1 &&
          o.timestamp <= a.occurredAt + 1500,
      ),
  );
  const deep = apis.find((x) => x.api === "DeepBook Indexer");
  const runningMs = Math.max(
    0,
    Math.min(
      elapsedMs,
      (latest?.runningMs ?? session.initialRunningMs) -
        session.initialRunningMs,
    ),
  );
  const validCycles = cycles.filter(
    (c) => !c.error && c.market?.healthy && c.market.source === "DeepBook",
  );
  const integrityFault = db.get<string>("validation_integrity_fault") ?? null;
  const criteria = [
    { name: "計測保存失敗・未確認の強制終了なし", ok: integrityFault === null },
    {
      name: "24時間の連続計測記録",
      ok:
        elapsedMs >= limits.durationMs &&
        samples.some((s) => s.at >= session.targetAt) &&
        maxGapMs <= limits.maxGapMs,
    },
    {
      name: "24時間のPAPER実稼働（許容差45秒）",
      ok: runningMs >= limits.durationMs - limits.maxGapMs,
    },
    {
      name: "DeepBook API成功率99%以上・P95がWorker待機周期未満",
      ok:
        !!deep &&
        deep.successRate != null &&
        deep.successRate >= limits.apiSuccessRate &&
        deep.latency.p95Ms != null &&
        deep.latency.p95Ms < session.intervalMs,
    },
    {
      name: "市場データ取得周期の記録・正常率99%以上",
      ok:
        cycles.length >= Math.floor(elapsedMs / (session.intervalMs + 45000)) &&
        cycles.length > 0 &&
        validCycles.length / cycles.length >= 0.99,
    },
    {
      name: "未解決欠損ゼロ・再構築45秒以内",
      ok:
        qualities.length > 0 &&
        latestQuality?.[300]?.unresolved === 0 &&
        qualities.every(
          (q) =>
            q.unresolved === 0 &&
            (q.reconstructionMs ?? Infinity) <= limits.maxReconstructionMs,
        ),
    },
    {
      name: "PAPER約定と安全証拠の一致・不正値/古い板による約定ゼロ",
      ok:
        orders.length === fills.length &&
        unsafeFills.length === 0 &&
        checks.every((c) => c.ok),
    },
    { name: "API異常時に即時注文禁止", ok: missingSafetyStops.length === 0 },
    {
      name: "重大停止・手動停止・再起動後の無許可再開なし",
      ok: unauthorizedRuns.length === 0,
    },
    {
      name: "Profit Guardを常時維持・Worker周期不変・分析実行あり",
      ok:
        samples.length > 0 &&
        windowSamples.every(
          (s) => s.profitGuard && s.intervalMs === session.intervalMs,
        ) &&
        Object.values(actions).reduce((a, b) => a + b, 0) > 0,
    },
    {
      name: "PAPER専用プロファイル・RiskEngineとProfit Guardの約定時承認",
      ok: fills.every(
        (f) =>
          f.mode === "PAPER" &&
          f.riskAllowed &&
          f.profitAllowed &&
          f.profitGuard,
      ),
    },
  ];
  const complete = elapsedMs >= limits.durationMs;
  return {
    pair,
    status: !complete
      ? "検証途中"
      : criteria.every((c) => c.ok)
        ? "合格"
        : "要確認（合格条件未達）",
    session,
    generatedAt: now,
    integrityFault,
    limits,
    elapsedMs,
    progress: Math.min(1, elapsedMs / limits.durationMs),
    runningMs,
    maxGapMs,
    sampleCount: samples.length,
    cycleCount: cycles.length,
    cycleSuccessRate: pct(validCycles.length, cycles.length),
    apis,
    market: latest?.market ?? cycles.at(-1)?.market ?? null,
    marketTiming: latest?.timing ?? cycles.at(-1)?.timing ?? null,
    candles: derived.candles,
    book: derived.book,
    paper: {
      analyses: Object.values(actions).reduce((a, b) => a + b, 0),
      actions,
      runningAnalyses: cycles.filter(
        (c) => c.action && c.execution?.analysis?.ordersAllowedAtAnalysis,
      ).length,
      stoppedAnalyses: cycles.filter(
        (c) =>
          c.action &&
          c.execution?.analysis &&
          !c.execution.analysis.runningAtAnalysis,
      ).length,
      gatedAnalyses: cycles.filter(
        (c) =>
          c.action &&
          c.execution?.analysis &&
          c.execution.analysis.runningAtAnalysis &&
          !c.execution.analysis.ordersAllowedAtAnalysis,
      ).length,
      unknownAnalysisState: cycles.filter(
        (c) => c.action && !c.execution?.analysis,
      ).length,
      unevaluatedCycles: cycles.filter((c) => !c.action).length,
      orderRequests: orderRequests.length,
      rejectedOrders: orderRequests.filter((o) => o.status === "REJECTED")
        .length,
      orders: orders.length,
      pnlUsdc:
        latest?.equity != null && session.initialEquity != null
          ? latest.equity - session.initialEquity
          : null,
      safetyStops: stops,
      guardedRecoveries: guardedRecoveries.length,
      manualStarts: starts.length,
      manualResumes: Math.max(0, starts.length - 1),
      restarts: operations.filter((e) => e.kind === "BOOT").length,
      unsafeFills: unsafeFills.length,
      missingFillEvidence: Math.max(0, orders.length - fills.length),
      missingSafetyStops: missingSafetyStops.length,
      unauthorizedRuns: unauthorizedRuns.length,
      fillChecksExercised: fills.length > 0,
      errorStopChecksExercised: failureApis.length > 0,
    },
    criteria,
    limitations: [
      "監視の追加API呼び出しはありません。API統計はキャッシュヒットを除く実試行単位です。",
      "欠損と再構築本数は5分足UTC時刻で重複を除外。失敗は取得周期単位で、後の成功で過去の障害は消えません。",
      "Indexer由来の板・遅延・無約定証拠です。独立したオンチェーン照合の保証ではありません。",
      "約定やAPI障害がなかった場合、その安全経路は実運用で未行使です。ユニット・統合テストも併せて確認してください。",
      "PAPER専用コードで記録します。実資金移動の独立したチェーン監査は行いません。",
      "24時間経過を理由に自動停止・再開しません。PAPER通信復旧は証拠付き安全確認後だけ許可します。評価対象は開始から24時間です。",
    ],
  };
}
export type ValidationReport = ReturnType<typeof aggregateValidation>;
