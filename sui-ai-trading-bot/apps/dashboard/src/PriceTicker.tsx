import React from "react";
import type { BotEngine } from "../../worker/src/engine.ts";

type State = ReturnType<BotEngine["snapshot"]>;
type Frames = State["candlesByTimeframe"];
type Candle = Frames[300][number];

const DAY_SECONDS = 86400;
/** Coarsest first: the hourly frame is the canonical 24h source. */
const TIMEFRAMES = [3600, 900, 300] as const;
const SPARK_WIDTH = 80;
const SPARK_HEIGHT = 24;
const SPARK_MAX_POINTS = 40;

/**
 * The one-line SUI/USDC price ticker that rides under the
 * operation bar on every tab. It derives everything from data
 * the dashboard already holds — no fetch of its own:
 *
 * - Price: the engine snapshot's `price` (the latest recorded
 *   five-minute candle close), refreshed by the shared summary
 *   poll on every tab.
 * - Change: computed from the recorded candle frames only.
 *   The market status carries no 24h change figure, so when a
 *   held frame reaches back a full day the change is the true
 *   24-hour change and is labelled 「24時間」; otherwise it is
 *   computed over the longest span actually recorded and the
 *   label names that span （時間／分／日）, so the number never
 *   claims a range the records do not cover.
 * - Sparkline: the closes of the same frame and window that
 *   produced the change, downsampled to at most 40 points. It
 *   is decoration; the accessible name carries price + change.
 *
 * Fail-closed per element: a missing price renders 「—」, and
 * when no recorded frame can ground a change, the change and
 * the sparkline are simply not rendered.
 */

export function formatTickerPrice(
  price: number | null | undefined,
): string {
  if (price == null || !Number.isFinite(price) || price <= 0)
    return "—";
  if (price >= 1000)
    return `$${new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(price)}`;
  const fixed = price.toFixed(4);
  const trimmed = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, ".00")
    : fixed;
  const [whole, fraction = ""] = trimmed.split(".");
  return `$${whole}.${(fraction + "00").slice(0, Math.max(2, fraction.length))}`;
}

export function formatChangePct(pct: number): string {
  const text = `${Math.abs(pct * 100).toFixed(2)}%`;
  if (pct > 0) return `+${text}`;
  if (pct < 0) return `-${text}`;
  return text;
}

export function changeTone(pct: number): "up" | "down" | "flat" {
  return pct > 0 ? "up" : pct < 0 ? "down" : "flat";
}

function spanLabel(seconds: number): string {
  if (seconds >= 48 * 3600) return `${Math.round(seconds / DAY_SECONDS)}日`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}時間`;
  return `${Math.max(1, Math.round(seconds / 60))}分`;
}

function cleanSeries(candles: Candle[] | undefined): Candle[] {
  if (!candles) return [];
  const byTimestamp = new Map<number, Candle>();
  for (const c of candles) {
    if (
      Number.isFinite(c?.timestamp) &&
      Number.isFinite(c?.close) &&
      c.close > 0
    )
      byTimestamp.set(c.timestamp, c);
  }
  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
}

export interface TickerChange {
  /** Fractional change over the window (0.0153 = +1.53%). */
  pct: number;
  /** What the window actually is: 「24時間」 or the recorded span. */
  label: string;
  /** Closes inside the window, oldest first — the sparkline series. */
  closes: number[];
}

/**
 * The grounded change for the ticker, or null when no recorded
 * frame can support one (fewer than two usable candles in every
 * frame). Prefers a true 24-hour change from the coarsest frame
 * that reaches back a full day (the reference candle must sit
 * within one frame of the 24h mark, so a gappy series cannot
 * silently stretch the window); falls back to the longest span
 * actually recorded, labelled with that span.
 */
export function tickerChange(frames: Frames): TickerChange | null {
  const cleaned = TIMEFRAMES.map((tf) => ({
    tf,
    series: cleanSeries(frames?.[tf]),
  }));
  for (const { tf, series } of cleaned) {
    if (series.length < 2) continue;
    const last = series[series.length - 1];
    const target = last.timestamp - DAY_SECONDS;
    let ref: Candle | undefined;
    for (const c of series) {
      if (c.timestamp <= target) ref = c;
      else break;
    }
    if (ref && target - ref.timestamp <= tf) {
      const pct = last.close / ref.close - 1;
      if (!Number.isFinite(pct)) continue;
      return {
        pct,
        label: "24時間",
        closes: series
          .filter((c) => c.timestamp >= ref.timestamp)
          .map((c) => c.close),
      };
    }
  }
  let best: { series: Candle[]; span: number } | null = null;
  for (const { series } of cleaned) {
    if (series.length < 2) continue;
    const span = series[series.length - 1].timestamp - series[0].timestamp;
    if (span > 0 && (!best || span > best.span)) best = { series, span };
  }
  if (!best) return null;
  const first = best.series[0];
  const last = best.series[best.series.length - 1];
  const pct = last.close / first.close - 1;
  if (!Number.isFinite(pct)) return null;
  return {
    pct,
    label: spanLabel(best.span),
    closes: best.series.map((c) => c.close),
  };
}

function downsample(values: number[], max: number): number[] {
  if (values.length <= max) return values;
  const out: number[] = [];
  const step = (values.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]);
  return out;
}

/**
 * Polyline points for the sparkline, or null when fewer than
 * two finite values remain. A flat series draws on the midline.
 */
export function sparklinePoints(
  values: number[],
  width = SPARK_WIDTH,
  height = SPARK_HEIGHT,
  maxPoints = SPARK_MAX_POINTS,
): string | null {
  const pts = downsample(
    values.filter((v) => Number.isFinite(v)),
    maxPoints,
  );
  if (pts.length < 2) return null;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const pad = 2;
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return pts
    .map((v, i) => {
      const x = round1((i / (pts.length - 1)) * width);
      const y =
        max === min
          ? height / 2
          : round1(pad + (1 - (v - min) / (max - min)) * (height - pad * 2));
      return `${x},${y}`;
    })
    .join(" ");
}

export function PriceTicker({
  price,
  candlesByTimeframe,
  glow = false,
}: {
  price: State["price"];
  candlesByTimeframe: Frames;
  /** Buy celebration: while true the ticker carries the glow
   * class and pulses gold once (motion permitting — the glow is
   * defined only under no-preference in style.css). */
  glow?: boolean;
}) {
  const change = tickerChange(candlesByTimeframe);
  const points = change ? sparklinePoints(change.closes) : null;
  const priceText = formatTickerPrice(price);
  const tone = change ? changeTone(change.pct) : null;
  const ariaLabel = change
    ? `SUI/USDC 現在価格 ${priceText}、${change.label}で${formatChangePct(change.pct)}`
    : `SUI/USDC 現在価格 ${priceText}`;
  const sparkStroke =
    tone === "up" ? "#43dfb2" : tone === "down" ? "#ff6b81" : "#9fb2c8";
  return (
    <div
      className={`price-ticker${glow ? " glow" : ""}`}
      role="img"
      aria-label={ariaLabel}
    >
      <span className="price-ticker-coin" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="15" height="15" focusable="false">
          <path
            d="M12 3c3.2 4.1 6 7.9 6 11a6 6 0 1 1-12 0c0-3.1 2.8-6.9 6-11z"
            fill="#4da2ff"
          />
        </svg>
      </span>
      <span className="price-ticker-symbol" aria-hidden="true">
        SUI/USDC
      </span>
      <span className="price-ticker-price" aria-hidden="true">
        {priceText}
      </span>
      {change && (
        <span
          className={`price-ticker-change ${tone}`}
          aria-hidden="true"
          title={`${change.label}の変動率（記録済みのローソク足から算出）`}
        >
          {formatChangePct(change.pct)}
          <span className="price-ticker-range">{change.label}</span>
        </span>
      )}
      {points && (
        <svg
          className="price-ticker-spark"
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          width={SPARK_WIDTH}
          height={SPARK_HEIGHT}
          aria-hidden="true"
          focusable="false"
        >
          <polyline
            points={points}
            fill="none"
            stroke={sparkStroke}
            strokeWidth="1.8"
          />
        </svg>
      )}
    </div>
  );
}
