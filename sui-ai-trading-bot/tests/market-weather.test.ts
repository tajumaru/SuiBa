import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type {
  Candle,
  Indicators,
} from "../packages/shared/src/index.ts";
import { marketWeather } from "../apps/worker/src/market-weather.ts";
import { MarketWeatherCard } from "../apps/dashboard/src/MarketWeatherCard.tsx";

const T0 = 1790532000; // arbitrary epoch-second anchor
const STEP = 300;

/** A flat 5-minute series at `close`, `count` candles long. */
function flat(count: number, close = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: T0 + i * STEP,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    source: "GeckoTerminal",
    timeframe: 300 as const,
  }));
}

/** 24h + margin of candles ramping linearly from `from` to `to`. */
function ramp(from: number, to: number, count = 300): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const close = from + ((to - from) * i) / (count - 1);
    return {
      timestamp: T0 + i * STEP,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1,
      source: "GeckoTerminal",
      timeframe: 300 as const,
    };
  });
}

function indicators(over: Partial<Indicators> = {}): Indicators {
  return {
    ema20: 100,
    ema50: 100,
    rsi: 50,
    macd: 0,
    signal: 0,
    histogram: 0,
    atr: 0.1,
    volumeChange: 0,
    priceChange: 0,
    ...over,
  };
}

describe("marketWeather", () => {
  it("returns null without indicators or a full 24h window", () => {
    expect(marketWeather(flat(300), null)).toBeNull();
    // Only 12 hours of candles: no 24h-ago reference exists.
    expect(marketWeather(flat(144), indicators())).toBeNull();
    expect(marketWeather([], indicators())).toBeNull();
    // Exactly 24h of candles still has no candle at the mark.
    expect(marketWeather(flat(288), indicators())).toBeNull();
  });

  it("returns null when the 24h-ago reference is stale", () => {
    const candles = flat(300);
    // Knock a 30-minute hole around the 24h-ago mark.
    const gapped = candles.filter(
      (c) => Math.abs(c.timestamp - (candles.at(-1)!.timestamp - 86400)) > 1800,
    );
    expect(marketWeather(gapped, indicators())).toBeNull();
  });

  it("grades a flat market cloudy and reports the evidence numbers", () => {
    const w = marketWeather(flat(300, 100), indicators({ atr: 0.2, rsi: 48 }));
    expect(w?.kind).toBe("cloudy");
    expect(w?.change24hPct).toBeCloseTo(0, 10);
    expect(w?.atrPct).toBeCloseTo(0.2, 10);
    expect(w?.rsi).toBe(48);
  });

  it("grades a steady rise sunny, and clear only with RSI behind it", () => {
    // +2.4% over the last 24h of the ramp.
    const candles = ramp(100, 103);
    expect(marketWeather(candles, indicators({ rsi: 50 }))?.kind).toBe(
      "sunny",
    );
    // +5% over 24h: clear at RSI 55+, only sunny below it.
    const strong = ramp(100, 106);
    expect(marketWeather(strong, indicators({ rsi: 60 }))?.kind).toBe(
      "clear",
    );
    expect(marketWeather(strong, indicators({ rsi: 55 }))?.kind).toBe(
      "clear",
    );
    expect(marketWeather(strong, indicators({ rsi: 54 }))?.kind).toBe(
      "sunny",
    );
  });

  it("grades a fall rain at the symmetric band", () => {
    const candles = ramp(100, 97); // −2.9% over the last 24h
    expect(marketWeather(candles, indicators())?.kind).toBe("rain");
    // Just inside the band stays cloudy.
    const barely = ramp(100, 98.8);
    expect(marketWeather(barely, indicators())?.kind).toBe("cloudy");
  });

  it("lets storm outrank direction at the ATR p95 band", () => {
    const strong = ramp(100, 106);
    // ATR% 0.66 ≥ 0.65 on a +5% rise: storm, not clear.
    expect(
      marketWeather(strong, indicators({ rsi: 60, atr: 0.7 }))?.kind,
    ).toBe("storm");
    // Just under the band the direction rules again.
    expect(
      marketWeather(strong, indicators({ rsi: 60, atr: 0.69 }))?.kind,
    ).toBe("storm");
    expect(
      marketWeather(strong, indicators({ rsi: 60, atr: 0.6 }))?.kind,
    ).toBe("clear");
  });

  it("honours the ±1.5% boundary", () => {
    // Reference close 80 (24h ago), latest 81.2 → +1.5%: sunny.
    const up = flat(300, 80);
    up[up.length - 1] = { ...up[up.length - 1], close: 81.2 };
    const wUp = marketWeather(up, indicators({ atr: 0.1 }));
    expect(wUp?.change24hPct).toBeCloseTo(1.5, 9);
    expect(wUp?.kind).toBe("sunny");
    // Reference close 200, latest 197 → −1.5%: rain.
    const down = flat(300, 200);
    down[down.length - 1] = { ...down[down.length - 1], close: 197 };
    const wDown = marketWeather(down, indicators({ atr: 0.2 }));
    expect(wDown?.change24hPct).toBeCloseTo(-1.5, 9);
    expect(wDown?.kind).toBe("rain");
  });
});

describe("MarketWeatherCard", () => {
  it("renders the grade, the three evidence numbers and the note", () => {
    const html = renderToStaticMarkup(
      createElement(MarketWeatherCard, {
        weather: { kind: "clear", change24hPct: 4.25, atrPct: 0.31, rsi: 61.6 },
      }),
    );
    expect(html).toContain("相場の天気");
    expect(html).toContain("快晴");
    expect(html).toContain("+4.25%");
    expect(html).toContain("0.31%");
    expect(html).toContain("62");
    expect(html).toContain("直近24時間の値動きからの機械判定");
  });

  it("renders nothing without a judgement", () => {
    const html = renderToStaticMarkup(
      createElement(MarketWeatherCard, { weather: null }),
    );
    expect(html).toBe("");
  });
});
