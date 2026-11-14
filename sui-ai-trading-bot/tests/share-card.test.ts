import { describe, expect, it } from "vitest";
import type { Candle } from "../packages/shared/src/index.ts";
import type { ChartForecast } from "../apps/dashboard/src/chartForecast.ts";
import type { ForecastScore } from "../apps/dashboard/src/forecastLog.ts";
import {
  buildShareCardSvg,
  shareCardInputFor,
} from "../apps/dashboard/src/shareCard.ts";

function candles(n: number, start = 1_700_000_100): Candle[] {
  const out: Candle[] = [];
  let price = 0.9;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = price + Math.sin(i / 5) * 0.002;
    out.push({
      timestamp: start + i * 300,
      timeframe: 300,
      open,
      high: Math.max(open, close) + 0.001,
      low: Math.min(open, close) - 0.001,
      close,
      volume: 100,
    } as Candle);
    price = close;
  }
  return out;
}

function forecast(
  direction: "up" | "down" | "flat",
  driftPct: number,
): ChartForecast {
  const base = 0.9;
  const points = Array.from({ length: 24 }, (_, i) => {
    const mid = base * (1 + (driftPct * (i + 1)) / 24);
    return {
      timestamp: 1_700_000_100 + (60 + i) * 300,
      mid,
      upper: mid * 1.01,
      lower: mid * 0.99,
    };
  });
  return {
    points,
    driftPct,
    bandPct: 0.02,
    direction,
    directionWord: direction === "up" ? "上昇" : "横ばい",
    bookTiltPct: 0,
  } as ChartForecast;
}

const SCORED: ForecastScore = {
  scoredRecords: 41,
  steps: 900,
  coveragePct: 84,
  dirTotal: 41,
  dirPct: 62,
  touchTotal: 0,
  touchHits: 0,
};

const base = {
  candles: candles(60),
  score: SCORED,
  displayName: "ぺんちゃん",
  characterImageSrc: "asset://pen",
  at: Date.UTC(2026, 10, 3, 7, 56),
};

describe("share card svg", () => {
  it("renders an up forecast with the recorded score", () => {
    const svg = buildShareCardSvg(
      {
        ...base,
        pairLabel: "SUI / USDC",
        forecast: forecast("up", 0.013),
      },
      "data:image/jpeg;base64,XXX",
    );
    expect(svg).toContain("SUI / USDC");
    expect(svg).toContain("予測 +1.3%");
    expect(svg).not.toContain('stroke-dasharray="7 6"');
    expect(svg).toContain("2時間で 上昇");
    expect(svg).toContain("ぺんちゃんの予測");
    expect(svg).toContain("コーン収まり 84%");
    expect(svg).toContain("方向的中 62%（41件）");
    expect(svg).toContain("data:image/jpeg;base64,XXX");
    expect(svg).toContain("予測は模式（EMA+ATR）");
    expect(svg).toContain("<polygon");
    expect(svg).toContain('width="1200" height="675"');
  });

  it("renders a down forecast in the down colour", () => {
    const svg = buildShareCardSvg(
      { ...base, pairLabel: "WAL / USDC", forecast: forecast("down", -0.02) },
      "data:,",
    );
    expect(svg).toContain("予測 -2.0%");
    expect(svg).toContain("2時間で 下落");
    expect(svg).toContain("#f77d8f");
  });

  it("shows 集計中 while the score is not ready", () => {
    const svg = buildShareCardSvg(
      {
        ...base,
        pairLabel: "SUI / USDC",
        forecast: forecast("flat", 0.001),
        score: {
          scoredRecords: 3,
          steps: 40,
          coveragePct: null,
          dirTotal: 0,
          dirPct: null,
          touchTotal: 0,
          touchHits: 0,
        },
      },
      "data:,",
    );
    expect(svg).toContain("2時間は 横ばい");
    expect(svg).toContain("集計中（判定 3 件）");
    expect(svg).not.toContain("方向的中 6");
  });

  it("keeps the direction score at 集計中 until 10 direction calls", () => {
    const svg = buildShareCardSvg(
      {
        ...base,
        pairLabel: "SUI / USDC",
        forecast: forecast("up", 0.01),
        score: { ...SCORED, dirTotal: 4, dirPct: 75 },
      },
      "data:,",
    );
    expect(svg).toContain("コーン収まり 84%");
    expect(svg).toContain("方向的中は集計中");
  });

  it("escapes the character name", () => {
    const svg = buildShareCardSvg(
      {
        ...base,
        pairLabel: "SUI / USDC",
        forecast: forecast("up", 0.01),
        displayName: 'a<&"',
      },
      "data:,",
    );
    expect(svg).toContain("a&lt;&amp;&quot;の予測");
    expect(svg).not.toContain('a<&"の予測');
  });
});

describe("share card input assembly", () => {
  const args = {
    pair: "SUI_USDC",
    candles: candles(80),
    forecast: forecast("up", 0.013),
    score: SCORED,
    character: "pen" as const,
    agentName: "",
    at: 123,
  };

  it("builds an input with the pen defaults", () => {
    const input = shareCardInputFor(args);
    expect(input).not.toBeNull();
    expect(input!.pairLabel).toBe("SUI / USDC");
    expect(input!.candles).toHaveLength(48);
    expect(input!.displayName).toBe("ぺんちゃん");
    expect(input!.characterImageSrc).toContain("agent-pen-normal");
  });

  it("uses the white character and WAL label when asked", () => {
    const input = shareCardInputFor({
      ...args,
      pair: "WAL_USDC",
      character: "white",
      agentName: "シロ",
    });
    expect(input!.pairLabel).toBe("WAL / USDC");
    expect(input!.displayName).toBe("シロ");
    expect(input!.characterImageSrc).toContain("agent-white-normal");
  });

  it("is null without enough candles", () => {
    expect(shareCardInputFor({ ...args, candles: [] })).toBeNull();
    expect(shareCardInputFor({ ...args, candles: candles(1) })).toBeNull();
  });
});
