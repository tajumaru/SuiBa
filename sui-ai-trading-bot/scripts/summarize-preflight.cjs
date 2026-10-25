const fs = require("node:fs");
const crypto = require("node:crypto");
const { endBookTiming } = require("./preflight-end-book.cjs");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const stats = (values) => {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  const p = (q) => (a.length ? a[Math.ceil(a.length * q) - 1] : null);
  return {
    n: a.length,
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    max: a.at(-1) ?? null,
  };
};
const counts = (values) =>
  Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((k) => [k, values.filter((x) => x === k).length]),
  );
const limits = Object.freeze({
  durationMs: 7200000,
  minAttempts: 100,
  bookAgeMs: 10000,
});
function summarize(rows, audit, inspection, context = null) {
  const observer = rows.find((r) => r.kind === "observer");
  const observedSamples = rows.filter((r) => r.kind === "sample");
  const knownUnsafe =
    audit?.runtime?.running === true ||
    inspection?.State?.OOMKilled === true ||
    observedSamples.some(
      (s) =>
        s.runtime?.running === true ||
        Object.values(s.counts ?? {}).some((n) => n > 0),
    );
  const invalidInput =
    !observer ||
    !audit ||
    !inspection ||
    !inspection.Image ||
    !Number.isInteger(inspection.RestartCount) ||
    !Array.isArray(audit.cycles) ||
    !Array.isArray(audit.events) ||
    !Array.isArray(audit.candles) ||
    !Array.isArray(audit.integrity) ||
    audit.integrity.length === 0 ||
    !audit.runtime ||
    !audit.tables ||
    !audit.build ||
    !audit.operations?.ledger ||
    !observedSamples.length ||
    observedSamples.some(
      (s) =>
        !Number.isFinite(s.at) ||
        !s.runtime ||
        !s.safety ||
        !s.counts ||
        !s.build ||
        !s.settingsSha256 ||
        !s.portfolio ||
        s.validationSession === undefined ||
        typeof s.profitGuard !== "boolean",
    ) ||
    rows.some(
      (r) => (r.kind === "api" && !r.data) || (r.kind === "cycle" && !r.frames),
    );
  if (invalidInput)
    return {
      verdict: knownUnsafe ? "NO-GO" : "INCONCLUSIVE",
      checks: {
        evidenceComplete: null,
        ...(knownUnsafe ? { safety: false } : {}),
      },
      criteria: {
        evidenceComplete: {
          status: "MISSING",
          source: "observer/audit/inspection",
          actual: null,
        },
      },
    };
  const identityFields = [
    "runId",
    "project",
    "sha",
    "durationMinutes",
    "measurementMode",
    "perfDetailEnabled",
  ];
  const identityAvailable =
    context &&
    audit.runIdentity &&
    observer &&
    identityFields.every(
      (key) =>
        context[key] != null &&
        observer[key] != null &&
        audit.runIdentity[key] != null,
    ) &&
    context.imageId != null &&
    observer.image != null &&
    audit.runIdentity.imageId != null;
  const identity = identityAvailable
    ? context.schemaVersion === 1 &&
      context.runId === observer?.runId &&
      context.sha === observer?.sha &&
      context.imageId === observer?.image &&
      context.durationMinutes === observer?.durationMinutes &&
      context.measurementMode === observer?.measurementMode &&
      context.perfDetailEnabled === observer?.perfDetailEnabled &&
      context.project === observer?.project &&
      context.project === inspection.Project &&
      context.project === audit.runIdentity?.project &&
      context.runId === audit.runIdentity?.runId &&
      context.sha === audit.runIdentity?.sha &&
      context.imageId === audit.runIdentity?.imageId &&
      context.durationMinutes === audit.runIdentity?.durationMinutes &&
      context.measurementMode === audit.runIdentity?.measurementMode &&
      context.perfDetailEnabled === audit.runIdentity?.perfDetailEnabled &&
      typeof context.runId === "string" &&
      context.runId.length > 0 &&
      Number.isFinite(context.durationMinutes) &&
      context.durationMinutes > 0 &&
      context.measurementMode === "passive-health-cache-v1" &&
      typeof context.perfDetailEnabled === "boolean"
    : null;
  // Only a versioned, identity-bound read-only terminal snapshot can extend the window.
  const candidate = audit.terminalSample;
  const terminal =
    identity === true &&
    candidate?.kind === "sample" &&
    candidate.at === audit.at &&
    candidate.runtime &&
    candidate.safety &&
    candidate.counts &&
    candidate.portfolio &&
    candidate.build &&
    candidate.settingsSha256 &&
    Array.isArray(candidate.integrity) &&
    candidate.validationSession !== undefined &&
    typeof candidate.profitGuard === "boolean"
      ? candidate
      : null;
  if (terminal) rows = [...rows, terminal];
  const allSamples = rows.filter((r) => r.kind === "sample");
  const start = allSamples[0].at;
  // Freeze the window at the last real heartbeat before the final read-only audit.
  // Include faults occurring during evidence collection after the 2h minimum.
  const boundedSamples = allSamples.filter(
    (r) => Number.isFinite(r.at) && r.at <= audit.at,
  );
  if (!boundedSamples.length)
    return { verdict: "INCONCLUSIVE", checks: { evidenceComplete: null } };
  const end = boundedSamples.at(-1).at;
  if (end < start)
    return {
      verdict: "NO-GO",
      checks: { endBookTiming: false },
      criteria: {
        endBookTiming: {
          status: "FAIL",
          reason: "AUDIT_BEFORE_OBSERVATION",
          actual: { start, auditAt: audit.at },
          source: "observer sample + audit.at",
        },
      },
    };
  const inWindow = (r) => r.at >= start && r.at <= end;
  const samples = allSamples.filter(inWindow);
  const cycles = rows.filter((r) => r.kind === "cycle" && inWindow(r));
  const attempts = rows
    .filter((r) => r.kind === "api" && inWindow(r))
    .map((r) => r.data);
  const lastCycle = cycles.at(-1);
  const first = samples[0],
    last = samples.at(-1);
  const apis = Object.fromEntries(
    ["DeepBook Indexer", "Sui gRPC"].map((name) => {
      const a = attempts
        .filter((x) => x.api === name)
        .sort((x, y) => x.occurredAt - y.occurredAt);
      const failed = a.filter((x) => !x.success);
      let run = 0,
        maxRun = 0;
      for (const x of a) {
        run = x.success ? 0 : run + 1;
        maxRun = Math.max(maxRun, run);
      }
      const failures = failed.map((x) => ({
        ...x,
        recoveredAt:
          a.find((y) => y.success && y.occurredAt > x.occurredAt)?.occurredAt ??
          null,
        priorCycleAt:
          cycles.filter((c) => c.at <= x.occurredAt).at(-1)?.at ?? null,
        nextSuccessfulCycleAt:
          cycles.find((c) => !c.error && c.at > x.occurredAt)?.at ?? null,
      }));
      return [
        name,
        {
          attempts: a.length,
          success: a.length - failed.length,
          failed: failed.length,
          successRate: a.length ? (a.length - failed.length) / a.length : null,
          retries: a.filter((x) => x.attempt > 0).length,
          maxConsecutiveFailures: maxRun,
          latencyMs: stats(a.map((x) => x.latencyMs)),
          successLatencyMs: stats(
            a.filter((x) => x.success).map((x) => x.latencyMs),
          ),
          failureCodes: counts(failed.map((x) => x.code)),
          failurePhases: counts(
            failed.map((x) => x.failure?.phase ?? "UNKNOWN"),
          ),
          failures,
        },
      ];
    }),
  );
  const frameReport = (tf) => {
    const observations = cycles.filter((c) => c.frames[tf]?.count);
    const latest = observations.at(-1);
    const problems = [];
    for (const c of observations) {
      const f = c.frames[tf];
      const ts = f.timestamps;
      if (
        f.count < 61 ||
        ts.some(
          (t, i) =>
            t % tf !== 0 ||
            (t + tf) * 1000 > c.at ||
            (i && t - ts[i - 1] !== tf),
        )
      )
        problems.push({ at: c.at, reason: "FRAME_CONTINUITY_OR_CLOSED" });
      if (c.at - (ts.at(-1) + tf) * 1000 > (tf + 60) * 1000)
        problems.push({ at: c.at, reason: "STALE_FRAME" });
    }
    const qualities = cycles.flatMap((c) =>
      c.market?.quality?.[tf]?.fetchedAt >= c.began
        ? [c.market.quality[tf]]
        : [],
    );
    const q = latest?.market?.quality?.[tf] ?? null;
    const gaps = [
      ...new Set(qualities.flatMap((q) => q.gapTimestamps ?? [])),
    ].sort((a, b) => a - b);
    const repairs = new Map(
      observations.flatMap((c) =>
        (c.frames[tf].repairs ?? []).map((r) => [r.timestamp, r.provenance]),
      ),
    );
    return {
      observations: observations.length,
      qualityObservations: qualities.length,
      continuityProblems: problems,
      latestCycleAt: latest?.at ?? null,
      latestCount: latest?.frames[tf].count ?? null,
      latestClosedAt: latest
        ? (latest.frames[tf].timestamps.at(-1) + tf) * 1000
        : null,
      ageAtEndMs: latest
        ? end - (latest.frames[tf].timestamps.at(-1) + tf) * 1000
        : null,
      latestQuality: q,
      gapTimestamps: gaps,
      repaired: [...repairs].map(([timestamp, provenance]) => ({
        timestamp,
        provenance,
      })),
      unresolvedObservations: qualities.filter((q) => q.unresolved > 0).length,
      maxUnresolved: Math.max(0, ...qualities.map((q) => q.unresolved)),
      reconstructionMs: stats(qualities.map((q) => q.reconstructionMs)),
    };
  };
  const frames = Object.fromEntries(
    [300, 900, 3600].map((tf) => [tf, frameReport(tf)]),
  );
  const successCycles = cycles.filter((c) => !c.error);
  const cycleStarts = audit.cycles.filter(
    (c) => c.phase === "START" && c.beganAt >= start && c.beganAt <= end,
  );
  const cycleEnds = audit.cycles.filter(
    (c) => c.phase === "END" && c.endedAt >= start && c.endedAt <= end,
  );
  const suilessSuccess = successCycles.filter(
    (c) =>
      !attempts.some(
        (a) =>
          a.api === "Sui gRPC" &&
          a.occurredAt >= c.began &&
          a.occurredAt <= c.at,
      ),
  );
  const invariant = {
    sampleCount: samples.length,
    maxSampleGapMs: Math.max(
      0,
      ...samples.slice(1).map((s, i) => s.at - samples[i].at),
    ),
    runningSamples: samples.filter((s) => s.runtime.running).length,
    resumePendingSamples: samples.filter((s) => s.safety.resumePending).length,
    nonzeroOrderSamples: samples.filter((s) =>
      Object.values(s.counts).some((n) => n !== 0),
    ).length,
    buildVariants: [
      ...new Set(samples.map((s) => JSON.stringify(s.build))),
    ].map(JSON.parse),
    settingsHashes: [...new Set(samples.map((s) => s.settingsSha256))],
    integrityBad: samples.filter((s) =>
      s.integrity?.some((r) => r.integrity_check !== "ok"),
    ).length,
    integrityChecks: samples.filter((s) => s.integrity).length,
    integrityFaults: samples.filter((s) => s.integrityFault).length,
    sessionSamples: samples.filter((s) => s.validationSession !== null).length,
    profitGuardOff: samples.filter((s) => !s.profitGuard).length,
    startPortfolio: first.portfolio,
    endPortfolio: last.portfolio,
    controls: audit.events.filter((e) => e.kind === "CONTROL"),
    allEventCodes: counts(audit.events.map((e) => e.code)),
    finalLedger: audit.operations?.ledger,
    finalIntegrity: audit.integrity,
    finalTables: audit.tables,
    finalRuntime: audit.runtime,
  };
  const completedCycleIds = cycles.map((c) => c.execution?.cycleId);
  const auditEndIds = cycleEnds.map((c) => c.cycleId);
  const missingAuditEnd = completedCycleIds.filter(
    (id) => !auditEndIds.includes(id),
  );
  const extraAuditEnd = auditEndIds.filter(
    (id) => !completedCycleIds.includes(id),
  );
  const lastSuccessfulCycle = successCycles.at(-1);
  const latestBookAge =
    lastSuccessfulCycle?.market?.bookAt == null
      ? null
      : lastSuccessfulCycle.at - lastSuccessfulCycle.market.bookAt;
  const checks = {
    twoHours: end - start >= limits.durationMs,
    deepbookMinAttempts:
      apis["DeepBook Indexer"].attempts >= limits.minAttempts,
    suiMinAttempts: apis["Sui gRPC"].attempts >= limits.minAttempts,
    deepbookSuccess:
      apis["DeepBook Indexer"].successRate == null
        ? null
        : apis["DeepBook Indexer"].successRate >= 0.99,
    suiSuccess:
      apis["Sui gRPC"].successRate == null
        ? null
        : apis["Sui gRPC"].successRate >= 0.99,
    cycleSuccess:
      cycles.length > 0 && successCycles.length / cycles.length >= 0.99,
    allFramesCurrent: [300, 900, 3600].every(
      (tf) =>
        frames[tf].latestQuality?.unresolved === 0 &&
        frames[tf].ageAtEndMs <= (tf + 60) * 1000 &&
        end - frames[tf].latestCycleAt <= 90000 &&
        frames[tf].continuityProblems.length === 0,
    ),
    bookFreshAtAcquisition:
      latestBookAge !== null &&
      latestBookAge <= 10000 &&
      end - lastCycle.at <= 90000,
    indexerFresh:
      lastCycle?.market?.diagnostics?.indexerLagMs != null &&
      lastCycle.market.diagnostics.indexerLagMs <= 60000,
    safety:
      invariant.runningSamples === 0 &&
      invariant.resumePendingSamples === 0 &&
      invariant.nonzeroOrderSamples === 0 &&
      invariant.profitGuardOff === 0 &&
      invariant.sessionSamples === 0 &&
      invariant.controls.length === 0 &&
      audit.runtime.running === false &&
      [
        "paper_orders",
        "paper_trades",
        "paper_checks",
        "operation_candidates",
      ].every((k) => audit.tables[k] === 0),
    integrity:
      invariant.integrityBad === 0 &&
      invariant.integrityFaults === 0 &&
      audit.integrity.every((r) => r.integrity_check === "ok") &&
      audit.operations?.ledger?.ok === true,
    evidenceComplete:
      invariant.maxSampleGapMs <= 45000 &&
      missingAuditEnd.length === 0 &&
      extraAuditEnd.length === 0,
    fixedBuild:
      invariant.buildVariants.length === 1 &&
      invariant.settingsHashes.length === 1 &&
      JSON.stringify(audit.build) === JSON.stringify(first.build) &&
      audit.settingsSha256 === first.settingsSha256 &&
      first.build.declaredSha === observer?.sha &&
      first.build.declaredImage === observer?.image &&
      inspection.Image === first.build.declaredImage &&
      inspection.RestartCount === 0,
  };
  invariant.runningCycleEvidence = cycles.filter(
    (c) =>
      c.execution?.runningAtStart ||
      c.execution?.analysis?.runningAtAnalysis ||
      c.execution?.analysis?.ordersAllowedAtAnalysis,
  ).length;
  invariant.runningAuditEvidence = audit.cycles.filter(
    (c) =>
      c.runningAtStart ||
      c.runningAtEnd ||
      c.analysis?.runningAtAnalysis ||
      c.analysis?.ordersAllowedAtAnalysis,
  ).length;
  checks.safety =
    checks.safety &&
    invariant.runningCycleEvidence === 0 &&
    invariant.runningAuditEvidence === 0 &&
    audit.tables.bot_settings === 0;
  checks.reconstructionWithinBudget = Object.values(frames).every(
    (f) => f.reconstructionMs.max === null || f.reconstructionMs.max <= 45000,
  );
  const probeTiming = terminal
    ? endBookTiming(audit.finalBook, start, end)
    : { status: "MISSING", reason: "END_BOOK_TIMING_MISSING" };
  const endProbeValid = probeTiming.status === "PASS";
  const finalBookAt = terminal
    ? endProbeValid
      ? audit.finalBook.timestamp
      : null
    : last.market?.bookAt;
  const finalBookAge = Number.isFinite(finalBookAt) ? end - finalBookAt : null;
  checks.bookFreshAtEnd =
    probeTiming.status === "FAIL"
      ? false
      : finalBookAge === null
        ? null
        : finalBookAge >= 0 && finalBookAge <= limits.bookAgeMs;
  checks.endBookTiming =
    probeTiming.status === "MISSING" ? null : probeTiming.status === "PASS";
  checks.runIdentity = identity;
  checks.terminalEvidence = terminal ? true : null;
  checks.plannedDuration =
    identity === true ? end - start >= context.durationMinutes * 60000 : null;
  checks.latestCycleSucceeded = lastCycle?.error === null;
  const invalidDbCandles = audit.candles.filter(
    (c) =>
      c.timestamp * 1000 <= end &&
      (![c.timestamp, c.open, c.high, c.low, c.close, c.volume].every(
        Number.isFinite,
      ) ||
        c.timestamp % c.timeframe !== 0 ||
        Math.min(c.open, c.high, c.low, c.close) <= 0 ||
        c.volume < 0 ||
        c.low > Math.min(c.open, c.close) ||
        c.high < Math.max(c.open, c.close) ||
        c.low > c.high),
  );
  invariant.invalidStoredCandles = invalidDbCandles.length;
  checks.integrity = checks.integrity && invalidDbCandles.length === 0;
  const requiredChecks = Object.keys(checks);
  const missing = requiredChecks.some((key) => checks[key] == null);
  const criteria = Object.fromEntries(
    requiredChecks.map((key) => [
      key,
      {
        status:
          checks[key] == null
            ? "MISSING"
            : checks[key]
              ? "PASS"
              : [
                    "twoHours",
                    "deepbookMinAttempts",
                    "suiMinAttempts",
                    "plannedDuration",
                  ].includes(key)
                ? "INSUFFICIENT"
                : "FAIL",
        actual: checks[key],
        source: "preflight observer + final audit",
      },
    ]),
  );
  Object.assign(criteria.twoHours, {
    actual: end - start,
    threshold: limits.durationMs,
    unit: "ms",
    source:
      "first observer sample to final identity-bound snapshot (legacy: last heartbeat)",
  });
  for (const [key, api] of [
    ["suiMinAttempts", "Sui gRPC"],
    ["deepbookMinAttempts", "DeepBook Indexer"],
  ])
    Object.assign(criteria[key], {
      actual: apis[api].attempts,
      threshold: limits.minAttempts,
      unit: "HTTP attempts",
      source: "kind=api; cache hits excluded",
    });
  Object.assign(criteria.plannedDuration, {
    actual: end - start,
    threshold: context ? context.durationMinutes * 60000 : null,
    unit: "ms",
    source: "run-context planned observation duration",
  });
  Object.assign(criteria.endBookTiming, {
    actual: audit.finalBook
      ? {
          startedAt: audit.finalBook.startedAt ?? null,
          completedAt: audit.finalBook.completedAt ?? null,
          durationMs: audit.finalBook.durationMs ?? null,
          upstreamTimestamp: audit.finalBook.timestamp ?? null,
          auditAt: end,
        }
      : null,
    reason: probeTiming.reason,
    source: "audit.finalBook timing + audit.at",
  });
  Object.assign(criteria.bookFreshAtEnd, {
    actual: finalBookAge,
    threshold: limits.bookAgeMs,
    unit: "ms",
    evaluatedAt: end,
    bookAt: finalBookAt ?? null,
    source: terminal
      ? "audit.finalBook (independent read-only end probe)"
      : "last observer market.bookAt",
  });
  Object.assign(criteria.runIdentity, {
    actual: context,
    source: "run-context/observer/audit",
  });
  const insufficient =
    !checks.twoHours ||
    !checks.deepbookMinAttempts ||
    !checks.suiMinAttempts ||
    checks.plannedDuration === false;
  const hardFailure = Object.entries(checks).some(
    ([k, v]) =>
      ![
        "twoHours",
        "deepbookMinAttempts",
        "suiMinAttempts",
        "plannedDuration",
      ].includes(k) && v === false,
  );
  return {
    start,
    end,
    durationMs: end - start,
    observer: rows.find((r) => r.kind === "observer"),
    apis,
    cycles: {
      count: cycles.length,
      success: successCycles.length,
      failed: cycles.length - successCycles.length,
      successRate: cycles.length ? successCycles.length / cycles.length : null,
      errors: counts(cycles.filter((c) => c.error).map((c) => c.error)),
      latencyMs: stats(cycles.map((c) => c.durationMs)),
      starts: cycleStarts.length,
      ends: cycleEnds.length,
      missingAuditEnd,
      extraAuditEnd,
      suiHealthSuccessWithoutActualAttempt: suilessSuccess.length,
      auditStartPhases: counts(cycleStarts.map((c) => c.phase)),
      actions: counts(cycles.map((c) => c.action ?? "NOT_EVALUATED")),
    },
    frames,
    book: {
      cycleAgeMs: stats(
        successCycles
          .filter((c) => c.market?.bookAt != null)
          .map((c) => c.at - c.market.bookAt),
      ),
      latestAcquisitionAgeMs: latestBookAge,
      latestSnapshotAgeAtEndMs: finalBookAge,
      indexerLagMs: stats(
        successCycles.map((c) => c.market?.diagnostics?.indexerLagMs),
      ),
    },
    safety: invariant,
    checks,
    criteria,
    limits,
    window: {
      start,
      end,
      source: terminal ? "terminal-audit" : "legacy-heartbeat",
      context,
    },
    verdict: hardFailure
      ? "NO-GO"
      : missing || insufficient
        ? "INCONCLUSIVE"
        : "GO",
  };
}
if (require.main === module) {
  const [evidence, audit, inspection, out, context] = process.argv.slice(2);
  const bytes = fs.readFileSync(evidence);
  const rows = bytes.toString("utf8").trim().split(/\r?\n/).map(JSON.parse);
  const result = summarize(
    rows,
    JSON.parse(fs.readFileSync(audit, "utf8")),
    JSON.parse(fs.readFileSync(inspection, "utf8")),
    context ? JSON.parse(fs.readFileSync(context, "utf8")) : null,
  );
  result.evidence = {
    fileSha256: hash(bytes),
    rows: rows.length,
    auditSha256: hash(fs.readFileSync(audit)),
    inspectionSha256: hash(fs.readFileSync(inspection)),
  };
  fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      verdict: result.verdict,
      durationMs: result.durationMs,
      checks: result.checks,
    }),
  );
}
module.exports = { summarize, stats };
