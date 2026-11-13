import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { DashboardService } from "../apps/worker/src/dashboard-feed.ts";
import { chartForecast } from "../packages/shared/src/chartForecast.ts";
import {
  forecastRecordFrom,
  scoreForecasts,
  latestAnswerCheck,
} from "../packages/shared/src/forecastLog.ts";
import { calibrationStep } from "../packages/shared/src/forecastCalib.ts";
import type { Candle } from "../packages/shared/src/index.ts";
import {
  advanceForecast,
  readForecast,
  importForecast,
} from "../apps/worker/src/forecast.ts";

const golden = JSON.parse(
  readFileSync(
    new URL("./fixtures/forecast-legacy-ae9483a.json", import.meta.url),
    "utf8",
  ),
);
const candles = golden.fixtures[0].candles as Candle[];

describe("worker forecasts", () => {
  it("matches frozen pre-move calculations, records, scoring and calibration exactly", () => {
    for (const f of golden.fixtures) {
      expect(
        chartForecast(f.candles.slice(0, 60), 24, f.imbalance, f.scale),
      ).toEqual(f.forecast);
      const records = Array.from({ length: 40 }, (_, i) =>
        forecastRecordFrom(
          chartForecast(f.candles.slice(0, 60 + i), 24, f.imbalance, f.scale)!,
          f.candles[59 + i].close,
        ),
      );
      expect(records).toEqual(f.records);
      expect(scoreForecasts(records, f.candles)).toEqual(f.score);
      expect(calibrationStep(f.score, { scale: f.scale, scoredAt: 0 })).toEqual(
        f.step,
      );
    }
  });

  it("runs 24 hours without a dashboard, scores and calibrates, and survives restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "suiba-forecast-"));
    const path = join(dir, "bot.sqlite");
    let db = new BotDatabase(path);
    try {
      const series = Array.from({ length: 350 }, (_, i) => ({
        ...candles[i % 120],
        timestamp: candles[0].timestamp + i * 300,
      }));
      for (let i = 60; i <= 348; i++) {
        const visible = series.slice(0, i);
        const old = readForecast(db, "SUI_USDC");
        const fc = chartForecast(visible, 24, null, old.calib.scale)!;
        const records = [
          ...old.records,
          forecastRecordFrom(fc, visible.at(-1)!.close),
        ].slice(-288);
        const expected = calibrationStep(
          scoreForecasts(records, visible),
          old.calib,
        );
        const state = advanceForecast(
          db,
          "SUI_USDC",
          visible,
          null,
          (visible.at(-1)!.timestamp + 300) * 1000,
        );
        expect(state.calib).toEqual(expected.calib);
        expect(state.score).toEqual(scoreForecasts(records, visible));
        expect(state.answer).toEqual(latestAnswerCheck(records, visible));
      }
      const state = readForecast(db, "SUI_USDC");
      expect(state.records).toHaveLength(288);
      expect(state.events.length).toBeGreaterThan(0);
      expect(db.history("forecast_records", 1000)).toHaveLength(289);
      expect(db.history("forecast_answers", 1000).length).toBeGreaterThan(250);
      expect(db.history("forecast_calibrations", 1000)).toHaveLength(
        state.events.length,
      );
      db.close();
      db = new BotDatabase(path);
      expect(readForecast(db, "SUI_USDC")).toEqual(state);
      expect(readForecast(db, "WAL_USDC").records).toEqual([]);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("continues ten-sample evaluations beyond the 288-record window without counting polls or restart twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "suiba-forecast-counter-"));
    const path = join(dir, "bot.sqlite");
    let db = new BotDatabase(path);
    try {
      const series = Array.from({ length: 701 }, (_, i) => ({
        ...candles[i % 120],
        timestamp: candles[0].timestamp + i * 300,
      }));
      const evaluations: number[] = [];
      for (let i = 60; i <= 700; i++) {
        const visible = series.slice(Math.max(0, i - 1000), i);
        const previous = readForecast(db, "SUI_USDC");
        const state = advanceForecast(
          db,
          "SUI_USDC",
          visible,
          null,
          i * 300000,
        );
        expect(state.scoredTotal).toBe(i - 60);
        expect(state.score.scoredRecords).toBe(Math.min(i - 60, 287));
        if (state.calib.scoredAt !== previous.calib.scoredAt)
          evaluations.push(state.calib.scoredAt);
        if (i === 400) {
          db.close();
          db = new BotDatabase(path);
          const repeated = advanceForecast(
            db,
            "SUI_USDC",
            visible,
            null,
            i * 300000 + 1,
          );
          expect(repeated.scoredTotal).toBe(state.scoredTotal);
          expect(repeated.calib).toEqual(state.calib);
        }
      }
      expect(evaluations).toEqual(
        Array.from({ length: 62 }, (_, i) => 30 + i * 10),
      );
      const state = readForecast(db, "SUI_USDC");
      expect(state.calib.scoredAt).toBe(640);
      expect(state.records).toHaveLength(288);
      for (const e of state.events) {
        expect(e.scored).toBeLessThanOrEqual(287);
        expect(e.totalScored! % 10).toBe(0);
      }
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("bootstraps an imported counter from existing samples once and preserves its batch position", () => {
    const db = new BotDatabase(":memory:");
    try {
      const f = golden.fixtures[1];
      importForecast(
        db,
        "SUI_USDC",
        {
          records: f.records.slice(0, 30),
          calib: { scale: 1.16, scoredAt: 30 },
        },
        1,
      );
      const first = advanceForecast(db, "SUI_USDC", f.candles, null, 2);
      expect(first.scoredTotal).toBe(30);
      expect(first.calib).toEqual({ scale: 1.16, scoredAt: 30 });
      expect(
        advanceForecast(db, "SUI_USDC", f.candles, null, 3).scoredTotal,
      ).toBe(30);
    } finally {
      db.close();
    }
  });

  it("imports the actual legacy multiplier once, preserves conflicting devices and retries", () => {
    const db = new BotDatabase(":memory:");
    try {
      const f = golden.fixtures[1];
      advanceForecast(db, "SUI_USDC", candles, null, 1);
      const payload = {
        records: f.records,
        calib: { scale: 1.16, scoredAt: 30 },
      };
      const receipt = importForecast(db, "SUI_USDC", payload, 2);
      expect(receipt.disposition).toBe("adopted");
      expect(readForecast(db, "SUI_USDC").calib).toEqual(payload.calib);
      expect(importForecast(db, "SUI_USDC", payload, 3)).toEqual(receipt);
      expect(db.history("forecast_imports")).toHaveLength(1);
      expect(
        importForecast(
          db,
          "SUI_USDC",
          { ...payload, calib: { scale: 1.05, scoredAt: 20 } },
          4,
        ).disposition,
      ).toBe("archived");
      expect(readForecast(db, "SUI_USDC").calib.scale).toBe(1.16);
      expect(
        db.history<{ payload: unknown }>("forecast_imports")[0].payload,
      ).toEqual({ ...payload, calib: { scale: 1.05, scoredAt: 20 } });
      expect(() =>
        importForecast(
          db,
          "SUI_USDC",
          { ...payload, calib: { scale: 99, scoredAt: 0 } },
          5,
        ),
      ).toThrow("INVALID_FORECAST_MIGRATION");
      importForecast(
        db,
        "WAL_USDC",
        { records: [], calib: { scale: 1, scoredAt: 0 } },
        6,
      );
      expect(readForecast(db, "WAL_USDC").migrationAdopted).toBe(false);
    } finally {
      db.close();
    }
  });

  it("generates from the real worker tick, while GETs and multiple dashboards are read-only", async () => {
    const db = new BotDatabase(":memory:");
    const now = (candles.at(-1)!.timestamp + 300) * 1000;
    const status = { healthy: true, checkedAt: now, failures: 0 };
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const engine = new BotEngine(
      db,
      { candles: async () => candles },
      {
        getQuote: async () => {
          throw Error("NO_TRADE");
        },
        validateQuote: async () => false,
      },
      { health: async () => status, status },
    );
    try {
      engine.monitor.boot();
      await engine.tick();
      expect(readForecast(db, "SUI_USDC").records).toHaveLength(1);
      const a = new DashboardService(engine, db),
        b = new DashboardService(engine, db);
      const before = readForecast(db, "SUI_USDC");
      expect(a.summary().summary.forecast).toEqual(
        b.summary().summary.forecast,
      );
      a.summary();
      b.summary();
      expect(readForecast(db, "SUI_USDC")).toEqual(before);
      expect(db.runtime().running).toBe(false);
      const runtimeError = db.runtime().error;
      const originalSet = db.set.bind(db);
      const writeFault = vi
        .spyOn(db, "set")
        .mockImplementation((key, value) => {
          if (key.startsWith("forecast.v1:"))
            throw Error("FORECAST_STORAGE_FAULT");
          return originalSet(key, value);
        });
      await engine.tick();
      expect(db.get<{ code: string }>("forecast_error")?.code).toBe(
        "FORECAST_UPDATE_FAILED",
      );
      expect(db.runtime().error).toBe(runtimeError);
      expect(readForecast(db, "SUI_USDC")).toEqual(before);
      writeFault.mockRestore();
    } finally {
      clock.mockRestore();
      db.close();
    }
  });
});
