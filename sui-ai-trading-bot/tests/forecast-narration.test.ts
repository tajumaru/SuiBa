import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  advanceNarration,
  emptyNarrationState,
} from "../apps/dashboard/src/agentNarration.ts";
import {
  forecastVerdictOf,
  type ForecastRecord,
} from "../apps/dashboard/src/forecastLog.ts";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";
import type { Candle } from "../packages/shared/src/index.ts";
import {
  persistNarration,
  restoreNarration,
} from "../apps/dashboard/src/narrationStorage.ts";
import { AgentFeedEntryRow } from "../apps/dashboard/src/AgentFeedEntryRow.tsx";

const T0 = Date.UTC(2026, 10, 3, 0, 0, 0); // ms
const MIN = 60_000;
const HOUR = 3600_000;

function ops(
  overrides: Partial<OperationsSnapshot> & Record<string, unknown>,
): OperationsSnapshot {
  return {
    status: "STOPPED",
    events: [],
    candidates: [],
    decision: null,
    safety: null,
    stopReason: null,
    ...overrides,
  } as unknown as OperationsSnapshot;
}

function rec(
  originSec: number,
  dir: "up" | "down" | "flat",
  drift = 0.012,
): ForecastRecord {
  const startClose = 100;
  const mid = Array.from(
    { length: 24 },
    (_, j) => startClose * (1 + (drift * (j + 1)) / 24),
  );
  return {
    origin: originSec,
    startClose,
    dir,
    up: mid.map((m) => m + 1),
    lo: mid.map((m) => m - 1),
    mid,
    tilt: null,
  };
}

function candle(tsSec: number, close: number): Candle {
  return {
    timestamp: tsSec,
    timeframe: 300,
    open: close,
    high: close + 0.01,
    low: close - 0.01,
    close,
    volume: 10,
    source: "GeckoTerminal",
  };
}

/** Candles covering a record's whole horizon, ending at
 * finalClose, plus one more candle so the final one is closed. */
function horizonCandles(originSec: number, finalClose: number): Candle[] {
  const out: Candle[] = [];
  for (let j = 0; j < 24; j++)
    out.push(
      candle(originSec + j * 300, 100 + ((finalClose - 100) * (j + 1)) / 24),
    );
  out.push(candle(originSec + 24 * 300, finalClose));
  return out;
}

const initialized = () => ({ ...emptyNarrationState(), initialized: true });

describe("forecastVerdictOf", () => {
  const origin = T0 / 1000 - 7200;
  it("judges a closed horizon by the final close", () => {
    const v = forecastVerdictOf(rec(origin, "up"), horizonCandles(origin, 101.5));
    expect(v?.hit).toBe(true);
    expect(v?.actualPct).toBeCloseTo(0.015);
    expect(v?.completedAt).toBe((origin + 7200) * 1000);
    const miss = forecastVerdictOf(
      rec(origin, "down", -0.012),
      horizonCandles(origin, 100.5),
    );
    expect(miss?.hit).toBe(false);
  });

  it("waits for the horizon to close and ignores flat or centre-less records", () => {
    const partial = horizonCandles(origin, 101.5).slice(0, 10);
    expect(forecastVerdictOf(rec(origin, "up"), partial)).toBeNull();
    const openFinal = horizonCandles(origin, 101.5).slice(0, 24);
    expect(forecastVerdictOf(rec(origin, "up"), openFinal)).toBeNull();
    expect(
      forecastVerdictOf(rec(origin, "flat"), horizonCandles(origin, 100)),
    ).toBeNull();
    const noMid = { ...rec(origin, "up"), mid: undefined };
    expect(forecastVerdictOf(noMid, horizonCandles(origin, 101.5))).toBeNull();
  });
});

describe("advanceNarration forecast declarations", () => {
  it("declares a fresh claimed forecast once, with its size", () => {
    const origin = T0 / 1000;
    const input = { records: [rec(origin, "up")], candles: [] as Candle[] };
    const next = advanceNarration(
      initialized(),
      ops({}),
      "sleeping",
      T0 + 2 * MIN,
      undefined,
      null,
      input,
    );
    const calls = next.entries.filter((e) => e.kind === "forecastCall");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("上昇 +1.2%");
    expect(calls[0].text).toContain("答え合わせは2時間後");
    expect(next.forecastDeclared[String(origin)]).toBe(T0 + 2 * MIN);
    const again = advanceNarration(
      next,
      ops({}),
      "sleeping",
      T0 + 3 * MIN,
      undefined,
      null,
      input,
    );
    expect(
      again.entries.filter((e) => e.kind === "forecastCall"),
    ).toHaveLength(1);
  });

  it("spaces declarations an hour apart and skips flat or stale claims", () => {
    const first = advanceNarration(
      initialized(),
      ops({}),
      "sleeping",
      T0,
      undefined,
      null,
      { records: [rec(T0 / 1000, "up")], candles: [] },
    );
    const secondOrigin = T0 / 1000 + 300;
    const cooled = advanceNarration(
      first,
      ops({}),
      "sleeping",
      T0 + 5 * MIN,
      undefined,
      null,
      {
        records: [rec(T0 / 1000, "up"), rec(secondOrigin, "down", -0.01)],
        candles: [],
      },
    );
    expect(
      cooled.entries.filter((e) => e.kind === "forecastCall"),
    ).toHaveLength(1);
    const thirdOrigin = T0 / 1000 + 3660;
    const later = advanceNarration(
      cooled,
      ops({}),
      "sleeping",
      T0 + 61 * MIN,
      undefined,
      null,
      { records: [rec(thirdOrigin, "down", -0.01)], candles: [] },
    );
    expect(
      later.entries.filter((e) => e.kind === "forecastCall"),
    ).toHaveLength(2);
    const quiet = advanceNarration(
      initialized(),
      ops({}),
      "sleeping",
      T0,
      undefined,
      null,
      {
        records: [
          rec(T0 / 1000, "flat", 0),
          rec(T0 / 1000 - 1800, "up"),
        ],
        candles: [],
      },
    );
    expect(
      quiet.entries.filter((e) => e.kind === "forecastCall"),
    ).toHaveLength(0);
  });
});

describe("forecast declaration reasons", () => {
  const telemetry = (overrides: Record<string, unknown>) =>
    ({
      evaluatedAt: T0 + 2 * MIN,
      candleTimestamp: T0,
      action: "WAIT",
      reason: "",
      selectedRule: "",
      sellPurpose: null,
      price: 100,
      entryPrice: null,
      ema20: 101,
      ema50: 100,
      rsi: 34,
      previousRsi: 29,
      histogram: -0.001,
      previousHistogram: -0.002,
      atr: 1,
      volumeChange: 0,
      oversold: 30,
      overbought: 70,
      stopLossPct: 0.02,
      takeProfitPct: 0.03,
      rsiLinePrice: null,
      conditions: {
        emaUp: true,
        emaGapShrinking: false,
        rsiRecovery: true,
        histogramImproving: true,
        hasPosition: false,
        stopLoss: false,
        takeProfit: false,
        latestVolumePositive: true,
        previousVolumePositive: true,
        volumeChangeExceeded: false,
        emaDown: false,
        rsiReversal: false,
        histogramDeclining: false,
      },
      ...overrides,
    }) as unknown as OperationsSnapshot["decision"];

  const declare = (
    dir: "up" | "down",
    decision: OperationsSnapshot["decision"],
    tilt: number | null = null,
  ) => {
    const origin = T0 / 1000;
    const record = { ...rec(origin, dir, dir === "up" ? 0.012 : -0.012), tilt };
    const next = advanceNarration(
      initialized(),
      ops({ decision }),
      "sleeping",
      T0 + 2 * MIN,
      undefined,
      null,
      { records: [record], candles: [] },
    );
    return next.entries.filter((e) => e.kind === "forecastCall")[0]?.text ?? "";
  };

  it("names the supporting facts on the record for an up call", () => {
    const text = declare("up", telemetry({}));
    expect(text).toContain(
      "根拠：RSIは回復しつつある、MACDも上向き、EMAは上向きの並び。",
    );
    expect(text).toContain("答え合わせは2時間後");
  });

  it("names book tilt and MACD for a down call, capping at three facts", () => {
    const text = declare(
      "down",
      telemetry({
        ema20: 99,
        ema50: 100,
        rsi: 55,
        previousRsi: 60,
        histogram: -0.003,
        previousHistogram: -0.001,
        conditions: {
          emaUp: false,
          emaGapShrinking: false,
          rsiRecovery: false,
          histogramImproving: false,
          hasPosition: false,
          stopLoss: false,
          takeProfit: false,
          latestVolumePositive: true,
          previousVolumePositive: true,
          volumeChangeExceeded: false,
          emaDown: true,
          rsiReversal: false,
          histogramDeclining: true,
        },
      }),
      -0.001,
    );
    expect(text).toContain("根拠：RSIは下向き、MACDも下向き、EMAは下向きの並び。");
    expect(text).not.toContain("板の売りが後押し");
  });

  it("keeps the plain call when there is no fresh evidence", () => {
    expect(declare("up", null)).not.toContain("根拠");
    const stale = telemetry({ evaluatedAt: T0 - 10 * MIN });
    expect(declare("up", stale)).not.toContain("根拠");
  });
});

describe("forecast calibration narration", () => {
  const event = (at: number, scored = 40) => ({
    at,
    scale: 1.08,
    scored,
    coveragePct: 65,
    widened: true,
  });

  it("tells a fresh calibration once and never repeats it", () => {
    const next = advanceNarration(
      initialized(),
      ops({}),
      "sleeping",
      T0,
      undefined,
      null,
      null,
      null,
      "SUI",
      event(T0),
    );
    const told = next.entries.filter((e) => e.kind === "forecastCalib");
    expect(told).toHaveLength(1);
    expect(told[0].text).toContain("学習：ここまでの予測40件");
    expect(next.lastCalibScoredAt).toBe(40);
    const again = advanceNarration(
      next,
      ops({}),
      "sleeping",
      T0 + MIN,
      undefined,
      null,
      null,
      null,
      "SUI",
      event(T0),
    );
    expect(
      again.entries.filter((e) => e.kind === "forecastCalib"),
    ).toHaveLength(1);
  });

  it("adopts a stale calibration silently", () => {
    const next = advanceNarration(
      initialized(),
      ops({}),
      "sleeping",
      T0,
      undefined,
      null,
      null,
      null,
      "SUI",
      event(T0 - 31 * MIN),
    );
    expect(next.entries.filter((e) => e.kind === "forecastCalib")).toHaveLength(0);
    expect(next.lastCalibScoredAt).toBe(40);
  });
});

describe("advanceNarration forecast verdicts", () => {
  const origin = T0 / 1000 - 7200;
  const declaredPrev = () => ({
    ...initialized(),
    forecastDeclared: { [String(origin)]: T0 - 2 * HOUR },
    lastForecastCallAt: T0 - 2 * HOUR,
  });

  it("tells a hit, sets the smug pose anchor, and settles once", () => {
    const input = {
      records: [rec(origin, "up")],
      candles: horizonCandles(origin, 101.5),
    };
    const next = advanceNarration(
      declaredPrev(),
      ops({}),
      "sleeping",
      T0,
      undefined,
      null,
      input,
    );
    const hits = next.entries.filter((e) => e.kind === "forecastHit");
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("的中");
    expect(hits[0].text).toContain("+1.5%");
    expect(next.lastHitAt).toBe(T0);
    expect(next.forecastSettled[String(origin)]).toBe(true);
    const again = advanceNarration(next, ops({}), "sleeping", T0 + MIN, undefined, null, input);
    expect(
      again.entries.filter((e) => e.kind === "forecastHit"),
    ).toHaveLength(1);
  });

  it("tells a miss plainly, and settles a stale verdict silently", () => {
    const miss = advanceNarration(
      declaredPrev(),
      ops({}),
      "sleeping",
      T0,
      undefined,
      null,
      {
        records: [rec(origin, "up")],
        candles: horizonCandles(origin, 99.2),
      },
    );
    const misses = miss.entries.filter((e) => e.kind === "forecastMiss");
    expect(misses).toHaveLength(1);
    expect(misses[0].text).toContain("外れ");
    expect(misses[0].text).toContain("-0.8%");

    const staleOrigin = T0 / 1000 - 5 * 3600;
    const stale = advanceNarration(
      {
        ...initialized(),
        forecastDeclared: { [String(staleOrigin)]: T0 - 5 * HOUR },
      },
      ops({}),
      "sleeping",
      T0,
      undefined,
      null,
      {
        records: [rec(staleOrigin, "up")],
        candles: horizonCandles(staleOrigin, 101.5),
      },
    );
    expect(
      stale.entries.filter(
        (e) => e.kind === "forecastHit" || e.kind === "forecastMiss",
      ),
    ).toHaveLength(0);
    expect(stale.forecastSettled[String(staleOrigin)]).toBe(true);
  });

  it("never verdicts a forecast that was not declared", () => {
    const next = advanceNarration(
      initialized(),
      ops({}),
      "sleeping",
      T0,
      undefined,
      null,
      {
        records: [rec(origin, "up")],
        candles: horizonCandles(origin, 101.5),
      },
    );
    expect(
      next.entries.filter((e) => e.kind === "forecastHit"),
    ).toHaveLength(0);
  });
});

describe("forecast narration rendering and storage", () => {
  it("renders the three tags", () => {
    const row = (kind: "forecastCall" | "forecastHit" | "forecastMiss") =>
      renderToStaticMarkup(
        createElement(AgentFeedEntryRow, {
          entry: { id: "e0", at: T0, kind, text: "x" },
        }),
      );
    expect(row("forecastCall")).toContain("予測");
    expect(row("forecastCall")).toContain(
      'class="agent-feed-entry-tag forecast"',
    );
    expect(row("forecastHit")).toContain("予測的中");
    expect(row("forecastMiss")).toContain("予測外れ");
  });

  it("round-trips declarations and the new entry kinds", () => {
    const backing = new Map<string, string>();
    const storage = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    };
    const entry = (
      id: string,
      kind: "forecastCall" | "forecastHit" | "forecastMiss",
    ) => ({ id, at: T0, kind, text: "x" });
    const state = {
      ...emptyNarrationState(),
      entries: [
        entry("e1", "forecastCall"),
        entry("e2", "forecastHit"),
        entry("e3", "forecastMiss"),
      ],
      nextEntryId: 3,
      forecastDeclared: { "123": T0 },
      forecastSettled: { "123": true },
      lastForecastCallAt: T0,
    };
    persistNarration(state, storage);
    const restored = restoreNarration(storage);
    expect(restored.entries.map((e) => e.kind)).toEqual([
      "forecastCall",
      "forecastHit",
      "forecastMiss",
    ]);
    expect(restored.forecastDeclared).toEqual({ "123": T0 });
    expect(restored.forecastSettled).toEqual({ "123": true });
    expect(restored.lastForecastCallAt).toBe(T0);
    // Old saves without the fields default cleanly.
    const raw = JSON.parse(backing.get("suiba.narration.v1")!) as Record<
      string,
      unknown
    >;
    delete raw.forecastDeclared;
    delete raw.forecastSettled;
    delete raw.lastForecastCallAt;
    backing.set("suiba.narration.v1", JSON.stringify(raw));
    const old = restoreNarration(storage);
    expect(old.forecastDeclared).toEqual({});
    expect(old.forecastSettled).toEqual({});
    expect(old.lastForecastCallAt).toBeNull();
  });
});
