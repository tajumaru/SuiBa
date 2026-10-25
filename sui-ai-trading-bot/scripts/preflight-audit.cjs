const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { createHash } = require("node:crypto");
(async () => {
  const identity = process.env.SUIBA_WINVERIFY_RUN_ID
    ? {
        runId: process.env.SUIBA_WINVERIFY_RUN_ID,
        project: process.env.SUIBA_PREFLIGHT_PROJECT,
        sha: process.env.SUIBA_BUILD_SHA,
        imageId: process.env.SUIBA_IMAGE_ID,
        durationMinutes: Number(process.env.SUIBA_WINVERIFY_DURATION_MINUTES),
        measurementMode: process.env.SUIBA_PREFLIGHT_MEASUREMENT_MODE,
        perfDetailEnabled: process.env.SUIBA_PERF_DETAIL === "1",
      }
    : null;
  const collectEnd = identity && process.argv.includes("--end-book");
  const finalBook = collectEnd
    ? await require("./preflight-end-book.cjs").captureEndBook()
    : null;
  const db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
  let audit;
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    const value = (key) => {
      const row = db
        .prepare("SELECT json FROM bot_runtime_state WHERE key=?")
        .get(key);
      return row ? JSON.parse(row.json) : null;
    };
    const tables = [
      "cycle_audits",
      "operation_events",
      "paper_orders",
      "paper_trades",
      "paper_checks",
      "operation_candidates",
      "bot_settings",
      "strategy_decisions",
      "risk_events",
      "validation_events",
    ];
    audit = {
      at: Date.now(),
      runtime: value("runtime"),
      safety: value("paper_safety"),
      timing: value("operation_state"),
      build: value("runtime_build"),
      settingsSha256: createHash("sha256")
        .update(JSON.stringify(value("settings")))
        .digest("hex"),
      profitGuard: value("settings")?.profitGuardEnabled,
      intervalMs: value("settings")?.intervalMs,
      session: value("validation_session"),
      portfolio: value("portfolio"),
      integrityFault: value("validation_integrity_fault"),
      quality: value("market_quality"),
      integrity: db.prepare("PRAGMA integrity_check").all(),
      tables: Object.fromEntries(
        tables.map((t) => [
          t,
          db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n,
        ]),
      ),
      cycles: db
        .prepare(
          "SELECT timestamp,json FROM cycle_audits ORDER BY timestamp,rowid",
        )
        .all()
        .map((r) => ({ timestamp: r.timestamp, ...JSON.parse(r.json) })),
      events: db
        .prepare(
          "SELECT timestamp,json FROM operation_events ORDER BY timestamp,rowid",
        )
        .all()
        .map((r) => ({ timestamp: r.timestamp, ...JSON.parse(r.json) })),
      candles: db
        .prepare(
          "SELECT timeframe,timestamp,source,json FROM market_candles ORDER BY timeframe,timestamp",
        )
        .all()
        .map((r) => JSON.parse(r.json)),
    };
    db.exec("ROLLBACK");
  } finally {
    db.close();
  }
  const auth = fs.readFileSync(process.env.ADMIN_TOKEN_FILE, "utf8").trim();
  const response = await fetch("http://127.0.0.1:3100/api/operations", {
    headers: { Authorization: "Bearer " + auth },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw Error("OPERATIONS_READ_FAILED");
  const operations = await response.json();
  audit.operations = {
    status: operations.status,
    mode: operations.mode,
    ledger: operations.accounting?.ledger,
    apis: operations.apis,
    timing: operations.timing,
    safety: operations.safety,
  };
  if (identity) {
    audit.runIdentity = identity;
    audit.finalBook = finalBook;
    if (collectEnd)
      audit.terminalSample = {
        kind: "sample",
        at: audit.at,
        runtime: audit.runtime,
        safety: audit.safety,
        timing: audit.timing,
        build: audit.build,
        settingsSha256: audit.settingsSha256,
        intervalMs: audit.intervalMs,
        profitGuard: audit.profitGuard,
        validationSession: audit.session,
        integrityFault: audit.integrityFault,
        portfolio: audit.portfolio,
        counts: Object.fromEntries(
          [
            "paper_orders",
            "paper_trades",
            "paper_checks",
            "operation_candidates",
          ].map((k) => [k, audit.tables[k]]),
        ),
        integrity: audit.integrity,
        market:
          finalBook?.timestamp == null ? null : { bookAt: finalBook.timestamp },
      };
  }
  console.log(JSON.stringify(audit));
})().catch(() => {
  console.error("AUDIT_READ_FAILED");
  process.exitCode = 1;
});
