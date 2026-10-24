import { BotDatabase } from "../packages/database/src/index.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lockFixture } from "./sqlite-lock-fixture.ts";
// Policy comparison only: baseline uses the prior 5000ms busy handler on NEW DBs.
// It does not access an existing DB or run the old bot.
const folder = mkdtempSync(join(tmpdir(), "suiba-lock-perf-"));
const results: unknown[] = [];
const q = (a: number[], v: number) =>
  a.slice().sort((a, b) => a - b)[Math.ceil(a.length * v) - 1];
for (const timeout of [5000, 0])
  for (const scenario of ["unlocked", "short100ms", "longHeld"]) {
    const delay: number[] = [],
      sqlMs: number[] = [];
    let successes = 0,
      failures = 0;
    for (let n = 0; n < 10; n++) {
      const path = join(folder, `${timeout}-${scenario}-${n}.sqlite`),
        db = new BotDatabase(path);
      const connection = (db as unknown as { db: DatabaseSync }).db;
      connection.exec(`PRAGMA busy_timeout=${timeout}`);
      const lock =
        scenario === "unlocked"
          ? null
          : await lockFixture(path, scenario === "short100ms" ? 100 : 0);
      try {
        const controller = new AbortController();
        const began = performance.now();
        const timer = new Promise<void>((resolve) =>
          setTimeout(() => {
            controller.abort();
            delay.push(performance.now() - began);
            resolve();
          }, 0),
        );
        const sqlStart = performance.now();
        try {
          db.append("sui_observations", String(n), { fixture: true });
          successes++;
        } catch {
          failures++;
        }
        sqlMs.push(performance.now() - sqlStart);
        await timer;
        if (!controller.signal.aborted) throw Error("ABORT_NOT_DISPATCHED");
        if (
          db.history("paper_orders").length ||
          db.history("paper_trades").length
        )
          throw Error("UNEXPECTED_ORDER");
      } finally {
        if (lock) await lock.terminate();
        db.close();
      }
    }
    const stat = (a: number[]) => ({
      p50: q(a, 0.5),
      p95: q(a, 0.95),
      max: Math.max(...a),
    });
    const result = {
      timeout,
      scenario,
      samples: 10,
      successes,
      failures,
      timerDispatchMs: stat(delay),
      sqlMs: stat(sqlMs),
      rawTimerMs: delay,
      rawSqlMs: sqlMs,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
const evidence = {
  node: process.version,
  method:
    "setTimeout(0) scheduled immediately before synchronous append; timer callback also dispatches AbortController. 10 independent fresh DBs per scenario. Short lock releases in another thread. Long lock held until append returns. Baseline restores only busy_timeout=5000; all other code identical.",
  results,
};
writeFileSync(join(folder, "result.json"), JSON.stringify(evidence, null, 2));
writeFileSync(
  "docs/SQLITE_LOCK_P1_BENCH.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
