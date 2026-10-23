// Differential regression against a fixed main archive; never opens an existing DB.
import { pathToFileURL } from "node:url";
import { resolve, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { deepStrictEqual } from "node:assert";
const baseline = resolve(process.env.BASELINE_ROOT!);
const current = resolve(".");
const load = (root: string, path: string) =>
  import(pathToFileURL(join(root, path)).href);
const versions = await Promise.all(
  [baseline, current].map(async (root) => ({
    ...(await load(root, "packages/database/src/index.ts")),
    ...(await load(root, "apps/worker/src/operations.ts")),
    ...(await load(root, "apps/worker/src/validation.ts")),
  })),
);
const out = resolve("data/performance/differential");
mkdirSync(out, { recursive: true });
const db = new versions[1].BotDatabase(
  join(out, `fixture-${process.pid}.sqlite`),
);
const start = 1792600000000,
  session = {
    id: "session",
    startedAt: start,
    targetAt: start + 86400000,
    initialRunningMs: 0,
    initialEquity: 10000,
    intervalMs: 15000,
  };
db.set("validation_session", session);
const monitors = versions.map((v) => new v.OperationMonitor(db, start));
const recorders = versions.map((v) => new v.ValidationRecorder(db));
let comparisons = 0;
const compare = (a: unknown, b: unknown) => {
  deepStrictEqual(a, b);
  comparisons++;
};
try {
  for (const size of [0, 1, 10000]) {
    if (size)
      db.transaction(() => {
        for (let i = size === 1 ? 0 : 1; i < size; i++) {
          const id = String(i).padStart(8, "0"),
            at = start + i;
          const orderId = i % 7 ? id : "duplicate";
          const expected = {
            ...db.portfolio(),
            tradeFee: i % 17 ? "0" : "1",
            gasUsdc: i % 19 ? "0" : "bad",
          };
          db.append(
            "paper_checks",
            id,
            { orderId, ok: i % 13 !== 0, expected },
            at,
          );
          db.append(
            "paper_trades",
            id,
            {
              orderId,
              timestamp: at,
              side: "BUY",
              fee: i % 23 ? "0" : null,
              costs: { gasUsdc: i % 29 ? "0" : "bad", dexFeeUsdc: "0" },
            },
            at,
          );
        }
      });
    compare(
      monitors[0].ledger(start + 100000),
      monitors[1].ledger(start + 100000),
    );
  }
  db.transaction(() => {
    for (let i = 0; i < 25000; i++) {
      const at = start + i * 1000;
      let event: unknown = {
        kind: "api",
        at,
        data: {
          api: i % 3 ? "DeepBook Indexer" : "Sui gRPC",
          occurredAt: at,
          attempt: i % 4,
          success: i % 17 !== 0,
          latencyMs: i % 999,
          code: i % 17 ? undefined : "UPSTREAM_NETWORK_FAILED",
        },
        safelyStopped: i % 2 === 0,
      };
      if (i % 7 === 0)
        event = {
          kind: "cycle",
          at,
          durationMs: i % 30000,
          market: null,
          error: i % 13 ? null : "FIXTURE_FAILURE",
          action: i % 2 ? "WAIT" : "BUY",
          bars: 2,
          timestamps: [i, i + 1],
          repairs: [],
        };
      if (i % 31 === 0)
        event = {
          kind: "sample",
          at,
          running: false,
          emergency: false,
          error: null,
          runningMs: i,
          profitGuard: true,
          intervalMs: 15000,
          equity: 10000,
          market: null,
        };
      if (i % 999 === 0)
        event = {
          kind: "fill",
          at,
          candles: [],
          mode: "PAPER",
          source: "invalid",
          running: false,
          riskAllowed: false,
          profitAllowed: false,
          profitGuard: true,
        };
      // Duplicate SQL timestamps, and SQL timestamp differs from JSON event at.
      db.append(
        "validation_events",
        String(i).padStart(8, "0"),
        event,
        start + Math.floor(i / 3) * 3000,
      );
      if (i % 200 === 0)
        db.append(
          "operation_events",
          String(i),
          { kind: "STOP", timestamp: at, code: "PAPER_NETWORK_PAUSED" },
          at,
        );
    }
  });
  for (const offset of [
    0, 9999, 10000, 15000, 3600000, 25000000, 86400000, 86445000, 86445001, 0,
  ]) {
    compare(
      recorders[0].report(start + offset, true),
      recorders[1].report(start + offset, true),
    );
  }
  db.set("validation_integrity_fault", "FIXTURE_SAVE_FAILURE");
  compare(
    recorders[0].report(start + 1, true),
    recorders[1].report(start + 1, true),
  );
  const reopened = versions.map((v) => new v.ValidationRecorder(db));
  compare(
    reopened[0].report(start + 20000, true),
    reopened[1].report(start + 20000, true),
  );
  // Strict equality differs from Map for NaN. Exercise the unpersisted malformed case.
  const range = db.range.bind(db);
  for (const orderId of [NaN, undefined, null, 0, -0, "duplicate", {}]) {
    db.range = (table: string, from: number, until: number) =>
      table === "paper_checks"
        ? [0, 1].map((fee) => ({
            orderId,
            ok: true,
            expected: {
              ...db.portfolio(),
              tradeFee: String(fee),
              gasUsdc: "0",
            },
          }))
        : table === "paper_trades"
          ? [{ orderId, fee: "0", costs: { gasUsdc: "0" } }]
          : range(table, from, until);
    compare(monitors[0].ledger(start), monitors[1].ledger(start));
  }
  db.range = range;
  const result = {
    comparisons,
    checkTradeRows: 10000,
    validationEvents: 25000,
    result: "all deeply equal",
    node: process.version,
  };
  writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
