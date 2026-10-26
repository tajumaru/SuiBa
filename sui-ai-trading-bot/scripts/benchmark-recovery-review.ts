import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { assertNodeVersion } from "./verify-node-version.mjs";
assertNodeVersion();
// Faithful pre-review scan: timestamp-filtered sorted arrays and separate count maps.
function before(db: BotDatabase, now: number) {
  const orders = db.range<{ id: string; status: string }>(
    "paper_orders",
    0,
    now,
  );
  const trades = db.range<{ orderId: string }>("paper_trades", 0, now);
  const checks = db.range<{ orderId: string; ok: boolean }>(
    "paper_checks",
    0,
    now,
  );
  const filled = new Set(
    orders.filter((o) => o.status === "FILLED").map((o) => o.id),
  );
  const tradeCounts = new Map<string, number>(),
    checkCounts = new Map<string, number>();
  for (const t of trades)
    tradeCounts.set(t.orderId, (tradeCounts.get(t.orderId) ?? 0) + 1);
  for (const c of checks)
    if (c.ok) checkCounts.set(c.orderId, (checkCounts.get(c.orderId) ?? 0) + 1);
  return (
    orders.every(
      (o) =>
        typeof o.id === "string" &&
        o.id.length > 0 &&
        (o.status === "REJECTED" ||
          (o.status === "FILLED" &&
            tradeCounts.get(o.id) === 1 &&
            checkCounts.get(o.id) === 1)),
    ) &&
    trades.every((t) => filled.has(t.orderId)) &&
    checks.every((c) => c.ok && filled.has(c.orderId))
  );
}
function measure(fn: () => boolean) {
  fn();
  const times: number[] = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    const start = performance.now();
    if (!fn()) throw new Error("INVALID_FIXTURE");
    times.push(performance.now() - start);
  }
  return times.sort((a, b) => a - b)[2];
}
const measurements = [];
for (const orders of [1000, 10000, 100000]) {
  const db = new BotDatabase(":memory:"),
    monitor = new OperationMonitor(db),
    now = Date.now();
  db.transaction(() => {
    for (let i = 0; i < orders; i++) {
      const id = `order:${i}`;
      db.append("paper_orders", id, { id, status: "FILLED", side: "BUY" }, i);
      db.append("paper_trades", id, { orderId: id, side: "BUY" }, i);
      db.append("paper_checks", id, { orderId: id, ok: true }, i);
    }
  });
  const after = () =>
    db.transaction(() =>
      (
        monitor as unknown as { recoveryOrdersKnown(now: number): boolean }
      ).recoveryOrdersKnown(now),
    );
  measurements.push({
    orders,
    rows: orders * 3,
    beforeMedianMs: measure(() => before(db, now)),
    afterMedianMs: measure(after),
  });
  db.close();
}
const report = {
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  repeats: 5,
  fixture:
    "Synthetic in-memory SQLite, minimal valid identity records; after includes proof write lock, ledger and I/O excluded",
  measurements,
};
writeFileSync(
  "docs/paper-recovery-review-performance.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.info(JSON.stringify(report, null, 2));
