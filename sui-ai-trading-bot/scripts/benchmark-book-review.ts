import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import { BotDatabase } from "../packages/database/src/index.ts";
import { observationAt } from "../packages/backtest-engine/src/book-observation-search.ts";
import { assertNodeVersion } from "./verify-node-version.mjs";
assertNodeVersion();
function measure(fn: () => number) {
  fn();
  const times: number[] = [];
  let result = 0;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    result = fn();
    times.push(performance.now() - start);
  }
  return { medianMs: times.sort((a, b) => a - b)[2], checksum: result };
}
const measurements = [];
for (const rows of [1000, 10000, 100000]) {
  const observations = Array.from({ length: rows }, (_, i) => ({
    observedAt: i * 30000,
    healthy: i % 17 !== 0,
  }));
  const queries = Array.from(
    { length: 1000 },
    (_, i) => Math.floor((i * (rows - 1)) / 1000) * 30000,
  );
  const before = measure(() =>
    queries.reduce(
      (sum, now) =>
        sum +
        (observations.findLast((o) => o.observedAt <= now)?.observedAt ?? -1),
      0,
    ),
  );
  const after = measure(() =>
    queries.reduce(
      (sum, now) => sum + (observationAt(observations, now)?.observedAt ?? -1),
      0,
    ),
  );
  if (before.checksum !== after.checksum) throw new Error("SEARCH_MISMATCH");
  measurements.push({
    rows,
    queries: queries.length,
    beforeMedianMs: before.medianMs,
    afterMedianMs: after.medianMs,
  });
}
const db = new BotDatabase(":memory:");
const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
const pages = () =>
  Number(raw.prepare("PRAGMA page_count").get()!.page_count) *
  Number(raw.prepare("PRAGMA page_size").get()!.page_size);
const beforeBytes = pages();
let jsonBytes = 0;
db.transaction(() => {
  for (let i = 0; i < 10000; i++) {
    const stamp = 1800000000000 + i * 60000;
    const value = {
      observedAt: stamp,
      healthy: true,
      book: {
        timestamp: stamp,
        bid: 1.999,
        ask: 2.001,
        spread: 0.001,
        bids: Array.from({ length: 10 }, (_, j) => [
          1.999 - j * 0.0001,
          123.456789,
        ]),
        asks: Array.from({ length: 10 }, (_, j) => [
          2.001 + j * 0.0001,
          123.456789,
        ]),
      },
    };
    jsonBytes += Buffer.byteLength(JSON.stringify(value));
    db.append("book_observations", `cycle:${i}`, value, stamp);
  }
});
const bytesPerRow = (pages() - beforeBytes) / 10000;
const storage = {
  sampleRows: 10000,
  averageJsonBytes: jsonBytes / 10000,
  measuredSqliteBytesPerRow: bytesPerRow,
  estimates: [1, 7, 30].map((days) => ({
    days,
    default60sMiB: (days * 1440 * bytesPerRow) / 1048576,
    defaultWithAllBoundaryRechecksMiB: (days * 1728 * bytesPerRow) / 1048576,
    minimum30sMiB: (days * 2880 * bytesPerRow) / 1048576,
  })),
};
db.close();
const report = {
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  repeats: 5,
  fixture:
    "Synthetic sorted observations; lookup only, clone/validation/replay excluded",
  measurements,
  storage,
  limitations:
    "Capacity is extrapolated from synthetic 10-level bids and asks with timestamp index; excludes other tables, WAL, archive duplication, and filesystem overhead.",
};
writeFileSync(
  "docs/book-history-review-performance.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.info(JSON.stringify(report, null, 2));
