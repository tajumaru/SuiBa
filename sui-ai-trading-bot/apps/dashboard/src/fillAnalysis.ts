import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import { chartSeries } from "./chartIndicators.ts";

/**
 * Condition-sliced performance of the bot's REAL fills
 * （条件別の成績）: every closed trade is attributed to the
 * buy that opened its position, and the closes are sliced by
 * that buy's conditions — its JST hour block, and the RSI the
 * chart's own series shows for the last candle that had
 * closed before the buy.
 *
 * Honest limits, surfaced in the UI: a close whose opening
 * buy fell outside the fills window cannot be attributed and
 * is left out (counted as `unattributed`); the RSI can only
 * be reconstructed while the candle window (newest 1,000
 * bars) still covers the buy, so the RSI slices state how
 * many closes they cover.
 */

export interface SliceStat {
  label: string;
  closes: number;
  wins: number;
  winRatePct: number | null;
  pnlUsdc: number;
}

export interface FillAnalysis {
  /** Closes attributed to an opening buy in the window. */
  closes: number;
  /** Closes whose opening buy is outside the window. */
  unattributed: number;
  /** Attributed closes whose entry RSI could be rebuilt. */
  rsiCovered: number;
  byHour: SliceStat[];
  byRsi: SliceStat[];
}

interface Close {
  pnl: number;
  entryAt: number;
  entryRsi: number | null;
}

const HOUR_BLOCKS: { label: string; from: number; to: number }[] = [
  { label: "朝 6–12時", from: 6, to: 12 },
  { label: "昼 12–18時", from: 12, to: 18 },
  { label: "夜 18–24時", from: 18, to: 24 },
  { label: "深夜 0–6時", from: 0, to: 6 },
];

const RSI_BANDS: { label: string; test: (rsi: number) => boolean }[] = [
  { label: "35以下", test: (r) => r <= 35 },
  { label: "35–45", test: (r) => r > 35 && r <= 45 },
  { label: "45–55", test: (r) => r > 45 && r <= 55 },
  { label: "55超", test: (r) => r > 55 },
];

const jstHour = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Tokyo",
  hour: "numeric",
  hourCycle: "h23",
});

function slices(
  closes: readonly Close[],
  groups: { label: string; has: (c: Close) => boolean }[],
): SliceStat[] {
  const out: SliceStat[] = [];
  for (const g of groups) {
    const mine = closes.filter(g.has);
    if (!mine.length) continue;
    const wins = mine.filter((c) => c.pnl > 0).length;
    out.push({
      label: g.label,
      closes: mine.length,
      wins,
      winRatePct: Math.round((wins / mine.length) * 100),
      pnlUsdc: mine.reduce((a, c) => a + c.pnl, 0),
    });
  }
  return out;
}

export function analyseFills(
  fills: readonly Fill[],
  candles: readonly Candle[],
): FillAnalysis {
  const series = chartSeries([...candles]);
  /** RSI of the last candle that had fully closed by `at`
   * (fill timestamps are ms; candle timestamps are seconds). */
  const rsiAt = (at: number): number | null => {
    let lo = 0;
    let hi = candles.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = candles[mid];
      if ((c.timestamp + c.timeframe) * 1000 <= at) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? series.rsi[found] : null;
  };

  const sorted = [...fills].sort((a, b) => a.timestamp - b.timestamp);
  const closes: Close[] = [];
  let unattributed = 0;
  let openQty = 0;
  let entry: { at: number; rsi: number | null } | null = null;
  const EPS = 1e-9;
  for (const f of sorted) {
    if (f.side === "BUY") {
      if (openQty <= EPS) entry = { at: f.timestamp, rsi: rsiAt(f.timestamp) };
      openQty += f.quantity;
    } else {
      if (f.pnl != null) {
        if (entry) closes.push({ pnl: f.pnl, entryAt: entry.at, entryRsi: entry.rsi });
        else unattributed += 1;
      }
      openQty -= f.quantity;
      if (openQty <= EPS) {
        openQty = 0;
        entry = null;
      }
    }
  }

  return {
    closes: closes.length,
    unattributed,
    rsiCovered: closes.filter((c) => c.entryRsi != null).length,
    byHour: slices(
      closes,
      HOUR_BLOCKS.map((b) => ({
        label: b.label,
        has: (c: Close) => {
          const h = Number(jstHour.format(new Date(c.entryAt)));
          return h >= b.from && h < b.to;
        },
      })),
    ),
    byRsi: slices(
      closes.filter((c) => c.entryRsi != null),
      RSI_BANDS.map((b) => ({
        label: b.label,
        has: (c: Close) => b.test(c.entryRsi ?? Number.NaN),
      })),
    ),
  };
}
