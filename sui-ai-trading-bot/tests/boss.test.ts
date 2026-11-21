import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoss, refreshBoss } from "../apps/worker/src/boss.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import type { Candle } from "../packages/shared/src/index.ts";

const pair = "SUI_USDC";
const hour = 3600;
const end = 1_800_000_000;
const now = (end + 300) * 1000;
const databases = new Set<BotDatabase>();
const dirs: string[] = [];
function database(path = ":memory:") {
  const db = new BotDatabase(path);
  databases.add(db);
  return db;
}
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function candle(
  timestamp: number,
  close: number,
  { high = close, low = close, timeframe = 300 } = {},
): Candle {
  return {
    timestamp,
    open: close,
    high,
    low,
    close,
    timeframe,
    volume: 1,
    source: "test",
  } as Candle;
}
function market(db: BotDatabase, close: number, rows: Candle[], at = now) {
  db.saveCandles(rows);
  db.set("price", close);
  refreshBoss(db, pair, at);
  return readBoss(db, pair);
}
function opening(db: BotDatabase, close = 93) {
  return market(db, close, [
    candle(end - 24 * hour, 100, { high: 110 }),
    candle(end - hour, 100),
    candle(end, close),
  ])!;
}

describe("boss battle", () => {
  it.each([
    [97, "閃光の投げ売り"],
    [95.5, "大・閃光の投げ売り"],
    [94, "真・閃光の投げ売り"],
  ])("classifies a one-hour close of %s as %s", (close, name) => {
    const db = database();
    db.set("indicators", { rsi: db.settings().oversold - 1 });
    expect(opening(db, close)).toMatchObject({
      type: "lightning",
      name,
      high: 110,
      low: close,
      turn: "boss",
      windowSeconds: hour,
    });
  });

  it.each([
    [95, "底なしの沼"],
    [92.5, "大・底なしの沼"],
    [90, "真・底なしの沼"],
  ])("classifies a 24-hour close of %s as %s", (close, name) => {
    const db = database();
    expect(
      market(db, close, [
        candle(end - 25 * hour + 300, 100, { timeframe: hour }),
        candle(end - hour, close),
        candle(end, close),
      ]),
    ).toMatchObject({ type: "swamp", name, windowSeconds: 24 * hour });
  });

  it("falls back to the retained period and reports its length", () => {
    expect(
      market(database(), 95, [
        candle(end - 3 * hour, 100),
        candle(end - hour, 95),
        candle(end, 95),
      ]),
    ).toMatchObject({ type: "swamp", windowSeconds: 3 * hour });
  });

  it("resumes from SQLite, updates the low and recovery, and retains the outcome", () => {
    const dir = mkdtempSync(join(tmpdir(), "suiba-boss-"));
    dirs.push(dir);
    const path = join(dir, "bot.sqlite");
    const before = database(path);
    const started = opening(before);
    before.close();
    databases.delete(before);

    const db = database(path);
    expect(readBoss(db, pair)).toEqual(started);
    db.set("indicators", { rsi: db.settings().oversold });
    const ongoing = market(
      db,
      91,
      [candle(end + 300 - hour, 100), candle(end + 300, 91, { low: 90 })],
      now + 300_000,
    );
    expect(ongoing).toMatchObject({
      startedAt: started.startedAt,
      startingEquity: started.startingEquity,
      low: 90,
      recovery: 0.05,
      turn: "hero",
      outcome: null,
    });
    const ended = market(db, 115, [candle(end + 600, 115)], now + 600_000);
    expect(ended).toMatchObject({
      recovery: 1,
      outcome: { result: "endured" },
    });
    expect(market(db, 115, [candle(end + 900, 115)], now + 900_000)).toEqual(
      ended,
    );
    expect(
      market(db, 85, [candle(end + 1200, 85)], now + 1_200_000),
    ).toMatchObject({
      startedAt: now + 1_200_000,
      outcome: null,
    });
  });

  it.each(["loss", "safety", "emergency", "manual", "profit"] as const)(
    "uses the recorded %s event to determine the ending",
    (event) => {
      const db = database();
      opening(db);
      const timestamp = now + 1000;
      if (event === "loss" || event === "profit") {
        db.append(
          "paper_trades",
          event,
          { timestamp, side: "SELL", pnl: event === "loss" ? -1 : 1 },
          timestamp,
        );
      } else {
        const code = {
          safety: "DAILY_LOSS_LIMIT",
          emergency: "EMERGENCY_STOP",
          manual: "MANUAL_STOP",
        }[event];
        db.append(
          "operation_events",
          event,
          { timestamp, kind: "STOP", code },
          timestamp,
        );
      }
      expect(
        market(db, 103, [candle(end + 300, 103)], now + 300_000)?.outcome
          ?.result,
      ).toBe(["manual", "profit"].includes(event) ? "endured" : "retreated");
    },
  );
});
