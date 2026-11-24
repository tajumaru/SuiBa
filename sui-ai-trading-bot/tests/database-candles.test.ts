import { expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";

type Candle = Parameters<BotDatabase["saveCandles"]>[0][number];

const candles: Candle[] = Array.from({ length: 6 }, (_, index) => ({
  timeframe: 300,
  timestamp: 1_800_000_000 + index * 300,
  source: "deepbook",
  open: 1,
  high: 3,
  low: 1,
  close: 2,
  volume: 10,
}));

function totalChanges(db: BotDatabase) {
  return Number(db.displayVersion().split(":")[0]);
}

it("writes only new or changed candles and preserves the saved series", () => {
  const db = new BotDatabase(":memory:");
  try {
    db.saveCandles(candles);
    const before = db.displayVersion();
    db.saveCandles(candles);
    db.saveCandles([]);
    expect(db.displayVersion()).toBe(before);

    const updated = candles.map((candle, index) =>
      index >= 4 ? { ...candle, close: 2.5 } : candle,
    );
    const changes = totalChanges(db);
    db.saveCandles(updated);
    expect(totalChanges(db) - changes).toBe(2);
    expect(db.candles()).toEqual(updated);
  } finally {
    db.close();
  }
});

it("compares mixed series separately and keeps input order for repeated keys", () => {
  const db = new BotDatabase(":memory:");
  try {
    const first = candles[0]!;
    const otherFrame: Candle = { ...first, timeframe: 900 };
    const otherSource: Candle = { ...first, source: "fallback", close: 2.25 };
    const mixed = [first, otherFrame, otherSource];
    db.saveCandles(mixed);
    const changes = totalChanges(db);
    db.saveCandles([...mixed].reverse());
    expect(totalChanges(db)).toBe(changes);
    expect(db.candles(900)).toEqual([otherFrame]);

    db.saveCandles([{ ...otherSource, close: 2.5 }, otherSource, otherSource]);
    expect(totalChanges(db) - changes).toBe(2);
    expect(db.candles()).toEqual([otherSource]);
    db.saveCandles([first]);
    expect(totalChanges(db) - changes).toBe(2);
  } finally {
    db.close();
  }
});
