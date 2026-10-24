import { BotDatabase } from "../packages/database/src/index.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
// Creates a NEW isolated evidence DB. Never accepts a path to an existing DB.
const folder = mkdtempSync(join(tmpdir(), "suiba-observation-review-"));
const path = join(folder, "fixture.sqlite"),
  db = new BotDatabase(path);
const row = {
  transportId: randomUUID(),
  layer: "HTTP",
  operation: "METADATA",
  requestId: randomUUID(),
  rpcId: randomUUID(),
  healthId: randomUUID(),
  cycleId: randomUUID(),
  coin: "SUI",
  at: Date.now(),
  elapsedMs: 300,
  success: true,
  code: null,
  transportAttempted: true,
  httpStatus: 200,
  network: {
    phase: "BODY",
    totalMs: 300,
    available: true,
    connectionId: 1,
    reusedConnection: false,
    protocol: "h1",
    dnsMs: 3,
    tcpMs: 30,
    tlsMs: 60,
    responseWaitMs: 200,
    bodyMs: 7,
  },
};
const times: number[] = [];
for (let n = 0; n < 1000; n++) {
  const start = performance.now();
  db.append("sui_observations", randomUUID(), row, row.at + n);
  times.push(performance.now() - start);
}
db.transaction(() => {
  for (let n = 1000; n < 70560; n++)
    db.append("sui_observations", randomUUID(), row, row.at + n);
});
const sql = new DatabaseSync(path);
sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const readTimes: number[] = [];
for (let n = 0; n < 100; n++) {
  const start = performance.now();
  if (db.history("sui_observations", 50).length !== 50)
    throw Error("BAD_HISTORY");
  readTimes.push(performance.now() - start);
}
const plan = sql
  .prepare(
    "EXPLAIN QUERY PLAN SELECT json FROM sui_observations ORDER BY timestamp DESC,id DESC LIMIT 50",
  )
  .all();
sql.exec("BEGIN IMMEDIATE");
const lockStart = performance.now();
let lockFailed = false;
try {
  db.append("sui_observations", randomUUID(), row);
} catch {
  lockFailed = true;
}
const lockWaitMs = performance.now() - lockStart;
sql.exec("ROLLBACK");
if (!lockFailed) throw Error("LOCK_NOT_ENFORCED");
const quant = (a: number[], q: number) =>
  a.slice().sort((a, b) => a - b)[Math.ceil(a.length * q) - 1];
const result = {
  node: process.version,
  rows: 70560,
  jsonBytes: Buffer.byteLength(JSON.stringify(row)),
  dbBytes: statSync(path).size,
  append1000: {
    p50Ms: quant(times, 0.5),
    p95Ms: quant(times, 0.95),
    maxMs: Math.max(...times),
  },
  history50at70560: {
    p50Ms: quant(readTimes, 0.5),
    p95Ms: quant(readTimes, 0.95),
    maxMs: Math.max(...readTimes),
  },
  lockFailed,
  lockWaitMs,
  plan,
  orders: db.history("paper_orders").length,
  trades: db.history("paper_trades").length,
  notes:
    "1000 FULL autocommits; remaining rows batched only for sizing. New temp DB retained as evidence.",
};
writeFileSync(join(folder, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
sql.close();
db.close();
