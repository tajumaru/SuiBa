import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
  advanceNarration,
  emptyNarrationState,
} from "../apps/dashboard/src/agentNarration.ts";
import { touchTargetFor } from "../apps/dashboard/src/chartForecast.ts";
import {
  forecastCallText,
  forecastTouchStateOf,
  scoreForecasts,
  touchStatusText,
  type ForecastRecord,
} from "../apps/dashboard/src/forecastLog.ts";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";
import type { Candle } from "../packages/shared/src/index.ts";
import { AgentFeedEntryRow } from "../apps/dashboard/src/AgentFeedEntryRow.tsx";

const T0 = Date.UTC(2026, 10, 4, 0, 0, 0); // ms
const MIN = 60_000;

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
  touch: { line: number; prob: number } | null = { line: 101, prob: 0.46 },
): ForecastRecord {
  const startClose = 100;
  const mid = Array.from(
    { length: 24 },
    (_, j) => startClose * (1 + (0.012 * (j + 1)) / 24),
  );
  return {
    origin: originSec,
    startClose,
    dir: "up",
    up: mid.map((m) => m + 1),
    lo: mid.map((m) => m - 1),
    mid,
    tilt: null,
    touch,
  };
}

function candle(
  tsSec: number,
  close: number,
  high = close + 0.01,
  low = close - 0.01,
): Candle {
  return {
    timestamp: tsSec,
    timeframe: 300,
    open: close,
    high,
    low,
    close,
    volume: 10,
    source: "GeckoTerminal",
  };
}

/** Window candles for a record, with a scripted extreme on one
 * of them, plus the closing candle after the horizon. */
function windowCandles(
  originSec: number,
  peakHigh: number,
  peakAt = 10,
): Candle[] {
  const out: Candle[] = [];
  for (let j = 0; j < 24; j++)
    out.push(
      candle(
        originSec + j * 300,
        100.2,
        j === peakAt ? peakHigh : 100.3,
        99.9,
      ),
    );
  out.push(candle(originSec + 24 * 300, 100.2));
  return out;
}

describe("touchTargetFor", () => {
  it("picks the ladder rung closest to a coin flip, farther on ties", () => {
    // up: 1.4 (54%) and 1.7 (46%) tie at 4pt away; farther wins.
    expect(touchTargetFor("up", 0.004)).toEqual({
      distPct: 1.7 * 0.004,
      prob: 0.46,
    });
    // down: 1.7 (47%) is closest outright.
    expect(touchTargetFor("down", 0.004)).toEqual({
      distPct: 1.7 * 0.004,
      prob: 0.47,
    });
  });

  it("has no target for flat forecasts or dead volatility", () => {
    expect(touchTargetFor("flat", 0.004)).toBeNull();
    expect(touchTargetFor("up", 0)).toBeNull();
  });
});

describe("forecastTouchStateOf", () => {
  const origin = T0 / 1000 - 7200;
  it("settles as touched the moment a high crosses the line", () => {
    const t = forecastTouchStateOf(rec(origin), windowCandles(origin, 101.2));
    expect(t?.phase).toBe("touched");
    expect(t?.closestAwayPct).toBe(0);
  });

  it("tracks the closest approach while pending", () => {
    const open = windowCandles(origin, 100.8).slice(0, 12);
    const t = forecastTouchStateOf(rec(origin), open);
    expect(t?.phase).toBe("pending");
    expect(t?.closestAwayPct).toBeCloseTo(101 / 100.8 - 1);
    expect(t?.awayPct).toBeCloseTo(101 / 100.2 - 1);
  });

  it("expires only once the horizon has closed", () => {
    const t = forecastTouchStateOf(rec(origin), windowCandles(origin, 100.8));
    expect(t?.phase).toBe("expired");
    const unclosed = forecastTouchStateOf(
      rec(origin),
      windowCandles(origin, 100.8).slice(0, 24),
    );
    expect(unclosed?.phase).toBe("pending");
  });

  it("has no state without a target", () => {
    expect(
      forecastTouchStateOf(rec(origin, null), windowCandles(origin, 101.2)),
    ).toBeNull();
  });

  it("feeds the score's touch counts", () => {
    const score = scoreForecasts(
      [rec(origin), rec(origin + 86400)],
      [
        ...windowCandles(origin, 101.2),
        ...windowCandles(origin + 86400, 100.5),
      ],
    );
    expect(score.touchTotal).toBe(2);
    expect(score.touchHits).toBe(1);
  });
});

describe("touch texts", () => {
  const origin = T0 / 1000;
  it("the declaration carries the line and its probability", () => {
    const text = forecastCallText(rec(origin));
    expect(text).toContain("$101.00");
    expect(text).toContain("確率は46%");
  });

  it("the status line counts down and reports a touch", () => {
    const pending = forecastTouchStateOf(
      rec(origin),
      windowCandles(origin, 100.8).slice(0, 12),
    )!;
    expect(touchStatusText(pending, pending.endsAt - 80 * MIN)).toContain(
      "残り 1:20",
    );
    const touched = forecastTouchStateOf(
      rec(origin),
      windowCandles(origin, 101.2),
    )!;
    expect(touchStatusText(touched, touched.endsAt)).toContain("タッチ済み");
  });
});

describe("advanceNarration touch settlements", () => {
  const initialized = () => ({
    ...emptyNarrationState(),
    initialized: true,
  });
  const declaredAt = (originSec: number) => ({
    ...initialized(),
    forecastDeclared: { [String(originSec)]: T0 },
  });

  it("tells a touch once, as its own kind, and not again", () => {
    const origin = T0 / 1000 - 3600;
    const input = {
      records: [rec(origin)],
      candles: windowCandles(origin, 101.2),
    };
    const next = advanceNarration(
      declaredAt(origin),
      ops({}),
      "sleeping",
      T0 + MIN,
      undefined,
      null,
      input,
    );
    const hits = next.entries.filter((e) => e.kind === "forecastTouch");
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("タッチ！");
    expect(hits[0].text).toContain("46%");
    expect(next.lastHitAt).toBe(T0 + MIN);
    const again = advanceNarration(
      next,
      ops({}),
      "sleeping",
      T0 + 2 * MIN,
      undefined,
      null,
      input,
    );
    expect(
      again.entries.filter((e) => e.kind === "forecastTouch"),
    ).toHaveLength(1);
  });

  it("tells a near miss and stays quiet about a distant one", () => {
    const origin = T0 / 1000 - 7200;
    const near = advanceNarration(
      declaredAt(origin),
      ops({}),
      "sleeping",
      T0 + MIN,
      undefined,
      null,
      { records: [rec(origin)], candles: windowCandles(origin, 100.8) },
    );
    const nears = near.entries.filter(
      (e) => e.kind === "forecastTouchNear",
    );
    expect(nears).toHaveLength(1);
    expect(nears[0].text).toContain("あと0.20%");
    const far = advanceNarration(
      declaredAt(origin),
      ops({}),
      "sleeping",
      T0 + MIN,
      undefined,
      null,
      { records: [rec(origin)], candles: windowCandles(origin, 100.4) },
    );
    expect(
      far.entries.filter((e) => e.kind.startsWith("forecastTouch")),
    ).toHaveLength(0);
    expect(far.forecastTouchSettled[String(origin)]).toBe(true);
  });

  it("renders both touch tags", () => {
    const row = (kind: "forecastTouch" | "forecastTouchNear") =>
      renderToStaticMarkup(
        createElement(AgentFeedEntryRow, {
          entry: {
            id: "x",
            at: T0,
            kind,
            text: "…",
          } as never,
          speakerName: "キャラ",
        }),
      );
    expect(row("forecastTouch")).toContain("タッチ");
    expect(row("forecastTouchNear")).toContain("タッチならず");
  });
});
