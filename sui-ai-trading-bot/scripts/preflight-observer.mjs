import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ValidationRecorder } from "/app/apps/worker/src/validation.ts";
const output = "/app/reports/preflight-evidence.jsonl";
const digest = (v) => createHash("sha256").update(v).digest("hex");
const emit = (record) => appendFileSync(output, JSON.stringify(record) + "\n");
const select = (value, keys) =>
  Object.fromEntries(
    keys.filter((k) => value?.[k] !== undefined).map((k) => [k, value[k]]),
  );
const market = (value) =>
  value == null
    ? null
    : select(value, [
        "configured",
        "source",
        "fallback",
        "lastSuccessAt",
        "latencyMs",
        "reason",
        "healthy",
        "bookAt",
        "bid",
        "ask",
        "spread",
        "diagnostics",
        "quality",
      ]);
const original = {};
for (const name of ["attempt", "cycle", "sample"])
  original[name] = ValidationRecorder.prototype[name];
ValidationRecorder.prototype.attempt = function (data) {
  const record = select(data, [
    "api",
    "success",
    "code",
    "latencyMs",
    "attempt",
    "occurredAt",
  ]);
  if (data.failure)
    record.failure = select(data.failure, [
      "api",
      "host",
      "operation",
      "method",
      "code",
      "causeCode",
      "phase",
      "status",
      "elapsedMs",
      "occurredAt",
      "startedAt",
      "endedAt",
      "retryCount",
      "lastSuccessAt",
      "lastApiSuccessAt",
      "timeoutType",
      "timeframe",
      "transportTimings",
    ]);
  emit({ kind: "api", at: Date.now(), data: record });
  return Reflect.apply(original.attempt, this, arguments);
};
ValidationRecorder.prototype.cycle = function (
  status,
  frames,
  action,
  error,
  began,
  now = Date.now(),
  execution,
) {
  emit({
    kind: "cycle",
    at: now,
    began,
    durationMs: now - began,
    action,
    error,
    execution,
    market: market(status),
    frames: Object.fromEntries(
      Object.entries(frames).map(([tf, rows]) => [
        tf,
        {
          count: rows.length,
          timestamps: rows.map((r) => r.timestamp),
          repairs: rows
            .filter((r) => r.provenance?.origin !== "ORIGINAL" && r.provenance)
            .map((r) => ({ timestamp: r.timestamp, provenance: r.provenance })),
        },
      ]),
    ),
  });
  return Reflect.apply(original.cycle, this, arguments);
};
let samples = 0;
ValidationRecorder.prototype.sample = function (status, now = Date.now()) {
  const db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    const value = (key) => {
      const row = db
        .prepare("SELECT json FROM bot_runtime_state WHERE key=?")
        .get(key);
      return row ? JSON.parse(row.json) : null;
    };
    const counts = Object.fromEntries(
      [
        "paper_orders",
        "paper_trades",
        "paper_checks",
        "operation_candidates",
      ].map((table) => [
        table,
        db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
      ]),
    );
    emit({
      kind: "sample",
      at: now,
      runtime: value("runtime"),
      safety: value("paper_safety"),
      timing: value("operation_state"),
      build: value("runtime_build"),
      settingsSha256: digest(JSON.stringify(value("settings"))),
      intervalMs: value("settings")?.intervalMs,
      profitGuard: value("settings")?.profitGuardEnabled,
      validationSession: value("validation_session"),
      integrityFault: value("validation_integrity_fault"),
      portfolio: value("portfolio"),
      counts,
      integrity:
        samples++ % 4 === 0 ? db.prepare("PRAGMA integrity_check").all() : null,
      market: market(status),
    });
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
  return Reflect.apply(original.sample, this, arguments);
};
emit({
  kind: "observer",
  runId: process.env.SUIBA_WINVERIFY_RUN_ID,
  project: process.env.SUIBA_PREFLIGHT_PROJECT,
  durationMinutes: Number(process.env.SUIBA_WINVERIFY_DURATION_MINUTES) || null,
  measurementMode: process.env.SUIBA_PREFLIGHT_MEASUREMENT_MODE,
  perfDetailEnabled: process.env.SUIBA_PERF_DETAIL === "1",
  at: Date.now(),
  node: process.version,
  sha: process.env.SUIBA_BUILD_SHA,
  image: process.env.SUIBA_IMAGE_ID,
  lockSha256: digest(readFileSync("/app/pnpm-lock.yaml")),
  observerSha256: digest(readFileSync(import.meta.filename)),
});
