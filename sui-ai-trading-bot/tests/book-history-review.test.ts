import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotDatabase } from "../packages/database/src/index.ts";
import { observationAt } from "../packages/backtest-engine/src/book-observation-search.ts";
import { compareStrategies } from "../packages/backtest-engine/src/strategy-comparison.ts";
import type { Candle } from "../packages/shared/src/index.ts";
const databases: BotDatabase[] = [],
  folders: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "suiba-book-review-"));
  folders.push(folder);
  const db = new BotDatabase(join(folder, "history.sqlite"));
  databases.push(db);
  for (let i = 1; i <= 10; i++)
    db.append(
      "book_observations",
      `observation:${i}`,
      { observedAt: i * 1000, healthy: false, book: null },
      i * 1000,
    );
  db.append(
    "strategy_decisions",
    "observation:1",
    { bookObservationId: "observation:1", evidence: { reason: "preserved" } },
    1000,
  );
  return { db, path: join(folder, "archive.json"), folder };
}
it("matches findLast on 100,000 observations for boundaries, future and missing history", () => {
  const rows = Array.from({ length: 100000 }, (_, i) => ({
    observedAt: i * 30,
    healthy: i % 9 !== 0,
  }));
  for (const now of [-1, 0, 1, 29, 30, 10000, 2999999, 3000001])
    expect(observationAt(rows, now)).toBe(
      rows.findLast((r) => r.observedAt <= now),
    );
  expect(observationAt([], 10)).toBeUndefined();
});
it("uses logarithmic lookup and retains the latest failure rather than older health", () => {
  let reads = 0;
  const rows = Array.from({ length: 131072 }, (_, i) => ({
    get observedAt() {
      reads++;
      return i;
    },
    healthy: i !== 65536,
  }));
  const latest = observationAt(rows, 65536);
  expect(latest?.healthy).toBe(false);
  expect(reads).toBeLessThanOrEqual(18);
});
it("preserves all history with retention disabled", () => {
  const { db, path } = fixture();
  expect(
    db.archiveAndPruneBookHistory(path, { retentionMs: 0, maxRows: 0 }, 999999)
      .deleted,
  ).toBe(0);
  expect(db.history("book_observations").length).toBe(10);
});
it("archives exact expired rows durably, preserves boundary/latest and decision evidence", () => {
  const { db, path } = fixture();
  const receipt = db.archiveAndPruneBookHistory(
    path,
    { retentionMs: 5000, maxRows: 0 },
    10000,
  );
  expect(receipt.deleted).toBe(4);
  const archive = JSON.parse(readFileSync(path, "utf8"));
  expect(archive.rows.map((r: { id: string }) => r.id)).toEqual(
    [1, 2, 3, 4].map((i) => `observation:${i}`),
  );
  expect(JSON.parse(archive.rows[0].json).observedAt).toBe(1000);
  expect(db.range("book_observations", 5000, 10000)).toHaveLength(6);
  expect(db.history("strategy_decisions")[0]).toMatchObject({
    evidence: { reason: "preserved" },
  });
  expect(db.history("book_history_archives")[0]).toMatchObject({
    sha256: receipt.sha256,
    deleted: 4,
  });
});
it("applies maxRows only after archive and can reconstruct the exact original comparison input", () => {
  const { db, path } = fixture();
  const before = db.range("book_observations", 0, 10000);
  expect(
    db.archiveAndPruneBookHistory(path, { retentionMs: 0, maxRows: 3 }, 10000)
      .deleted,
  ).toBe(7);
  const archived = JSON.parse(readFileSync(path, "utf8")).rows.map(
    (r: { json: string }) => JSON.parse(r.json),
  );
  expect([...archived, ...db.range("book_observations", 0, 10000)]).toEqual(
    before,
  );
});
it("never deletes when archive creation fails or would overwrite a file", () => {
  const { db, path } = fixture();
  writeFileSync(path, "existing");
  expect(() =>
    db.archiveAndPruneBookHistory(path, { retentionMs: 1, maxRows: 2 }, 10000),
  ).toThrow();
  expect(db.history("book_observations")).toHaveLength(10);
  expect(readFileSync(path, "utf8")).toBe("existing");
  expect(db.history("book_history_archives")).toHaveLength(0);
});
it("rolls back deletion if archiving receipt fails", () => {
  const { db, path } = fixture();
  db.append("book_history_archives", "bad", {});
  const raw = (db as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  raw.exec(
    "CREATE TRIGGER fail_archive BEFORE INSERT ON book_history_archives BEGIN SELECT RAISE(ABORT,'fixture'); END;",
  );
  expect(() =>
    db.archiveAndPruneBookHistory(path, { retentionMs: 1, maxRows: 2 }, 10000),
  ).toThrow();
  expect(db.history("book_observations")).toHaveLength(10);
});
it("requires stopped PAPER and rejects malformed retention", () => {
  const { db, path } = fixture();
  expect(() =>
    db.archiveAndPruneBookHistory(path, { retentionMs: -1, maxRows: 2 }),
  ).toThrow("INVALID_BOOK_RETENTION");
  db.set("runtime", { ...db.runtime(), running: true });
  expect(() =>
    db.archiveAndPruneBookHistory(path, { retentionMs: 1, maxRows: 2 }),
  ).toThrow("REQUIRES_STOP");
});
it("preserves existing DB data across additive schema initialization", () => {
  const { db, folder } = fixture();
  const second = new BotDatabase(join(folder, "history.sqlite"));
  databases.push(second);
  expect(second.history("book_observations")).toEqual(
    db.history("book_observations"),
  );
  expect(second.history("strategy_decisions")).toEqual(
    db.history("strategy_decisions"),
  );
});
it("rejects equal-time observations, excludes future and stale data, and reproduces comparisons", async () => {
  const base = 1800000000;
  const candles: Candle[] = Array.from({ length: 100 }, (_, i) => ({
    timestamp: base + i * 300,
    timeframe: 300,
    source: "SYNTHETIC",
    open: 2,
    close: 2,
    high: 2.01,
    low: 1.99,
    volume: 100000,
  }));
  const options = {
    start: candles[65].timestamp,
    end: candles[99].timestamp,
    trainEnd: candles[64].timestamp,
  };
  const observations = [
    { observedAt: base * 1000, healthy: false, book: null },
  ];
  const a = await compareStrategies(candles, options, observations);
  expect(await compareStrategies(candles, options, observations)).toEqual(a);
  await expect(
    compareStrategies(candles, options, [...observations, ...observations]),
  ).rejects.toThrow("CHRONOLOGICAL");
  const stamp = candles[65].timestamp * 1000;
  const stale = [
    {
      observedAt: stamp,
      healthy: true,
      book: {
        timestamp: stamp - 10001,
        bid: 1.999,
        ask: 2.001,
        spread: 0.001,
        bids: [[1.999, 100]],
        asks: [[2.001, 100]],
      },
    },
  ];
  expect(
    (await compareStrategies(candles, options, stale)).coverage.covered,
  ).toBe(0);
  const future = [{ ...stale[0], observedAt: stamp + 100000000 }];
  expect((await compareStrategies(candles, options, future)).candidate).toEqual(
    a.candidate,
  );
});

it("does not fall back to a healthy book when the latest available observation is abnormal", async () => {
  const base = 1800000000;
  const candles: Candle[] = Array.from({ length: 100 }, (_, i) => ({
    timestamp: base + i * 300,
    timeframe: 300,
    source: "SYNTHETIC",
    open: 2,
    close: 2,
    high: 2.01,
    low: 1.99,
    volume: 100000,
  }));
  const options = {
    start: candles[65].timestamp,
    end: candles[99].timestamp,
    trainEnd: candles[64].timestamp,
  };
  const stamp = candles[65].timestamp * 1000;
  const healthy = {
    observedAt: stamp - 1,
    healthy: true,
    book: {
      timestamp: stamp - 1,
      bid: 1.999,
      ask: 2.001,
      spread: 0.001,
      bids: [[1.999, 100]],
      asks: [[2.001, 100]],
    },
  };
  expect(
    (await compareStrategies(candles, options, [healthy])).coverage.covered,
  ).toBe(1);
  expect(
    (
      await compareStrategies(candles, options, [
        healthy,
        { observedAt: stamp, healthy: false, book: null },
      ])
    ).coverage.covered,
  ).toBe(0);
});
