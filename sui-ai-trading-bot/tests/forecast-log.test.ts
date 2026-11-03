import { describe, expect, it } from "vitest";
import type { Candle } from "../packages/shared/src/index.ts";
import { chartForecast } from "../apps/dashboard/src/chartForecast.ts";
import {
  appendForecastRecord,
  forecastRecordFrom,
  forecastScoreText,
  loadForecastLog,
  saveForecastLog,
  scoreForecasts,
  MAX_FORECAST_RECORDS,
  type ForecastRecord,
} from "../apps/dashboard/src/forecastLog.ts";

const T0 = Date.UTC(2026, 10, 1, 0) / 1000;
function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    timestamp: T0 + i * 300,
    timeframe: 300,
    open: close,
    high: close + 0.005,
    low: close - 0.005,
    close,
    volume: 10,
    source: "GeckoTerminal",
  }));
}
const rising = candles(
  Array.from({ length: 60 }, (_, i) => 2 + i * 0.012),
);
function recordFrom(series: Candle[]): ForecastRecord {
  const fc = chartForecast(series)!;
  return forecastRecordFrom(fc, series.at(-1)!.close);
}

describe("forecast log", () => {
  it("snapshots origin, direction and band arrays", () => {
    const rec = recordFrom(rising);
    expect(rec.origin).toBe(rising.at(-1)!.timestamp + 300);
    expect(rec.dir).toBe("up");
    expect(rec.up).toHaveLength(24);
    expect(rec.lo).toHaveLength(24);
    expect(rec.startClose).toBe(rising.at(-1)!.close);
  });

  it("dedupes by origin and caps the log", () => {
    const rec = recordFrom(rising);
    let log = appendForecastRecord([], rec);
    log = appendForecastRecord(log, rec);
    expect(log).toHaveLength(1);
    const same = appendForecastRecord(log, { ...rec, origin: rec.origin + 300 });
    expect(same).toHaveLength(2);
    let big: ForecastRecord[] = [];
    for (let i = 0; i < MAX_FORECAST_RECORDS + 5; i++)
      big = appendForecastRecord(big, { ...rec, origin: rec.origin + i * 300 });
    expect(big).toHaveLength(MAX_FORECAST_RECORDS);
    expect(big[0].origin).toBe(rec.origin + 5 * 300);
  });

  it("scores coverage only over steps whose actual candle exists", () => {
    const rec = recordFrom(rising);
    // Actuals continue the trend: closes stay inside a wide cone.
    const future = Array.from({ length: 24 }, (_, j) => ({
      timestamp: rec.origin + j * 300,
      timeframe: 300,
      open: rec.startClose,
      high: rec.startClose + 0.01,
      low: rec.startClose - 0.01,
      close: (rec.up[j] + rec.lo[j]) / 2,
      volume: 10,
      source: "GeckoTerminal",
    })) as Candle[];
    const full = scoreForecasts([rec], future);
    expect(full.scoredRecords).toBe(1);
    expect(full.steps).toBe(24);
    expect(full.coveragePct).toBe(100);
    // Only the first 6 actuals exist: 6 steps scored, direction pending.
    const partial = scoreForecasts([rec], future.slice(0, 6));
    expect(partial.steps).toBe(6);
    expect(partial.dirTotal).toBe(0);
    // No actuals at all: nothing scored.
    expect(scoreForecasts([rec], []).scoredRecords).toBe(0);
  });

  it("scores direction only for named directions, against the final close", () => {
    const rec = recordFrom(rising); // dir "up"
    const mk = (close: number): Candle[] =>
      Array.from({ length: 24 }, (_, j) => ({
        timestamp: rec.origin + j * 300,
        timeframe: 300,
        open: close,
        high: close,
        low: close,
        close,
        volume: 10,
        source: "GeckoTerminal",
      }));
    const up = scoreForecasts([rec], mk(rec.startClose * 1.02));
    expect(up.dirTotal).toBe(1);
    expect(up.dirPct).toBe(100);
    const down = scoreForecasts([rec], mk(rec.startClose * 0.98));
    expect(down.dirPct).toBe(0);
    // A flat forecast never enters direction scoring.
    const flatRec: ForecastRecord = { ...rec, dir: "flat" };
    expect(scoreForecasts([flatRec], mk(rec.startClose * 1.02)).dirTotal).toBe(0);
  });

  it("gates the score text until enough forecasts are scored", () => {
    expect(forecastScoreText(scoreForecasts([], []), 0)).toBeNull();
    const rec = recordFrom(rising);
    const one = scoreForecasts([rec], candles(Array(200).fill(2)).slice(0, 0));
    expect(forecastScoreText(one, 1)).toContain("集計中");
    // 10 scored records -> percentages appear.
    const future: Candle[] = [];
    const recs: ForecastRecord[] = [];
    for (let k = 0; k < 10; k++) {
      const r = { ...rec, origin: rec.origin + k * 86400 };
      recs.push(r);
      for (let j = 0; j < 24; j++)
        future.push({
          timestamp: r.origin + j * 300,
          timeframe: 300,
          open: r.startClose,
          high: r.startClose,
          low: r.startClose,
          close: (r.up[j] + r.lo[j]) / 2,
          volume: 10,
          source: "GeckoTerminal",
        });
    }
    const text = forecastScoreText(scoreForecasts(recs, future), recs.length);
    expect(text).toContain("コーン収まり 100%");
    expect(text).toContain("アプリを開いていた間");
  });

  it("round-trips through storage per pair and rejects junk", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const rec = recordFrom(rising);
    saveForecastLog([rec], "SUI_USDC", storage);
    expect(loadForecastLog("SUI_USDC", storage)).toEqual([rec]);
    expect(loadForecastLog("WAL_USDC", storage)).toEqual([]);
    store.set("suiba.forecastLog.v1", "{not json");
    expect(loadForecastLog("SUI_USDC", storage)).toEqual([]);
    store.set(
      "suiba.forecastLog.v1",
      JSON.stringify([{ origin: -1, startClose: 0, dir: "up", up: [], lo: [] }]),
    );
    expect(loadForecastLog("SUI_USDC", storage)).toEqual([]);
  });
});
