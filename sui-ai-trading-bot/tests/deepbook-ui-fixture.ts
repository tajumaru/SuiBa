import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { ValidationRecorder } from "../apps/worker/src/validation.ts";
export const uiNow = Date.UTC(2026, 9, 22, 3);
export const scenarios = [
  "unstarted",
  "stopped",
  "running",
  "api-error",
  "missing",
  "safety-stop",
  "partial",
  "failed",
  "passed",
  "restarted",
] as const;
export type Scenario = (typeof scenarios)[number];
export function validationFixture(scenario: Scenario) {
  const db = new BotDatabase(":memory:");
  const health = { healthy: true, checkedAt: uiNow, failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw Error("NO_ORDER");
      },
      validateQuote: async () => false,
    },
    { health: async () => health, status: health },
  );
  engine.monitor.boot(uiNow);
  const recorder = new ValidationRecorder(db);
  const complete = scenario === "failed" || scenario === "passed";
  if (scenario !== "unstarted")
    recorder.begin(uiNow - (complete ? 86400000 : 3600000));
  const report = recorder.report(uiNow, true);
  const operations = { ...engine.monitor.snapshot(uiNow), validation: report };
  const state = engine.snapshot();
  operations.status = [
    "running",
    "api-error",
    "missing",
    "partial",
    "restarted",
  ].includes(scenario)
    ? "RUNNING"
    : scenario === "safety-stop"
      ? "ABNORMAL_STOP"
      : "STOPPED";
  operations.stopReason =
    scenario === "safety-stop" ? "MARKET_DATA_STALLED" : null;
  operations.timing.dataStatus = scenario === "unstarted" ? "UNKNOWN" : "FRESH";
  operations.timing.transportRecent = scenario !== "api-error";
  if (report.session) {
    report.market = {
      configured: "deepbook",
      source: "deepbook",
      fallback: false,
      lastSuccessAt: uiNow - 1000,
      latencyMs: 120,
      reason: null,
      healthy: scenario !== "api-error",
      bookAt: uiNow - 1000,
      bid: 2,
      ask: 2.001,
      spread: 0.0005,
    };
    report.apis = [
      {
        api: "DeepBook Indexer",
        requests: 29,
        successes: scenario === "api-error" ? 28 : 29,
        successRate: scenario === "api-error" ? 28 / 29 : 1,
        retries: 0,
        failures: scenario === "api-error" ? 1 : 0,
        codes: scenario === "api-error" ? { UPSTREAM_TIMEOUT: 1 } : {},
        latency: { count: 29, averageMs: 120, p95Ms: 140, maxMs: 150 },
        lastSuccessAt: uiNow - 1000,
      },
    ];
    report.candles!.reconstructed = 11;
    report.candles!.unresolved = scenario === "missing" ? 2 : 0;
    report.candles!.latestQuality = {
      300: {
        upstream: "DeepBook Indexer",
        pair: "SUI_USDC",
        fetchedAt: uiNow - 1000,
        timeframe: 300,
        missing: 11,
        reconstructed: 11,
        unresolved: scenario === "missing" ? 2 : 0,
        latestClosedAt: uiNow - 300000,
        origins: {
          ORIGINAL: 999,
          ONE_MINUTE_AGGREGATE: 11,
          NO_INDEXED_TRADES: 0,
        },
      },
    };
    report.runningMs = operations.status === "RUNNING" ? 1800000 : 0;
    if (complete) {
      report.status = scenario === "passed" ? "合格" : "要確認（合格条件未達）";
      report.criteria = [
        { name: "24時間の計測記録", ok: true },
        { name: "十分なPAPER実稼働時間", ok: scenario === "passed" },
      ];
    }
  }
  db.close();
  return { report, operations, state };
}
