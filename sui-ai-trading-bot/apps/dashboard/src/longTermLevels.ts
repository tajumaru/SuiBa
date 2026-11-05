import type { DailyCandle } from "../../../packages/shared/src/index.ts";

/**
 * The long-term level map: landmarks computed mechanically
 * from daily candles, nothing hand-drawn.
 *
 * - Period opens (year / quarter / month): the open of the
 *   first daily candle inside the period. Daily candles are
 *   UTC days, so this is the price at the period's first
 *   09:00 JST — a landmark, not a tick-exact boundary print.
 *   A period open is only named when the series actually
 *   covers the period's start (within two days); otherwise
 *   the level is omitted rather than faked from the series'
 *   first candle.
 * - Period high / low: the plain extremes of the series.
 * - One trend line: swing highs/lows (±3-day local extremes).
 *   A descending resistance from the highest swing high and
 *   the highest later, lower swing high — unless the price
 *   has already broken it, in which case an ascending
 *   support from the mirrored swing lows is tried. A broken
 *   line is not drawn as if it still stood.
 *
 * Display only; nothing here feeds the bot or its forecasts.
 */

const DAY = 86400;
const JST = 9 * 3600;

export interface LongTermLevel {
  price: number;
  label: string;
  kind: "yearOpen" | "quarterOpen" | "monthOpen" | "high" | "low";
}

export interface TrendLine {
  t1: number;
  p1: number;
  t2: number;
  p2: number;
  kind: "resistance" | "support";
}

function jstParts(tSec: number): { y: number; m: number } {
  const d = new Date((tSec + JST) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() };
}

/** Open of the period containing the last candle, when the
 * series covers the period's start. `periodStartUtc` gives
 * the UTC-midnight timestamp of the period's first day. */
function periodOpen(
  daily: readonly DailyCandle[],
  keyOf: (tSec: number) => string,
  periodStartUtc: (tSec: number) => number,
): number | null {
  const last = daily.at(-1);
  if (!last) return null;
  const key = keyOf(last.timestamp);
  const first = daily.find((c) => keyOf(c.timestamp) === key);
  if (!first) return null;
  return Math.abs(first.timestamp - periodStartUtc(last.timestamp)) <=
    2 * DAY
    ? first.open
    : null;
}

export function longTermLevels(daily: readonly DailyCandle[]): LongTermLevel[] {
  if (daily.length < 30) return [];
  const last = daily.at(-1)!;
  const { y, m } = jstParts(last.timestamp);
  const out: LongTermLevel[] = [];
  const year = periodOpen(
    daily,
    (t) => `y${jstParts(t).y}`,
    () => Date.UTC(y, 0, 1) / 1000,
  );
  if (year != null) out.push({ price: year, label: "年始値", kind: "yearOpen" });
  const quarter = periodOpen(
    daily,
    (t) => {
      const p = jstParts(t);
      return `q${p.y}-${Math.floor(p.m / 3)}`;
    },
    () => Date.UTC(y, Math.floor(m / 3) * 3, 1) / 1000,
  );
  if (quarter != null)
    out.push({ price: quarter, label: "四半期始値", kind: "quarterOpen" });
  const month = periodOpen(
    daily,
    (t) => {
      const p = jstParts(t);
      return `m${p.y}-${p.m}`;
    },
    () => Date.UTC(y, m, 1) / 1000,
  );
  if (month != null) out.push({ price: month, label: "月始値", kind: "monthOpen" });
  let high = -Infinity,
    low = Infinity;
  for (const c of daily) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  out.push({ price: high, label: "期間高値", kind: "high" });
  out.push({ price: low, label: "期間安値", kind: "low" });
  return out.sort((a, b) => b.price - a.price);
}

function swings(
  daily: readonly DailyCandle[],
  pick: "high" | "low",
): { t: number; p: number }[] {
  const out: { t: number; p: number }[] = [];
  for (let i = 3; i < daily.length - 3; i++) {
    const v = daily[i][pick];
    let extreme = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      if (pick === "high" ? daily[j].high >= v : daily[j].low <= v) {
        extreme = false;
        break;
      }
    }
    if (extreme) out.push({ t: daily[i].timestamp, p: v });
  }
  return out;
}

const lineAt = (l: TrendLine, t: number) =>
  l.p1 + ((l.p2 - l.p1) * (t - l.t1)) / (l.t2 - l.t1);

export function longTermTrend(daily: readonly DailyCandle[]): TrendLine | null {
  if (daily.length < 60) return null;
  const last = daily.at(-1)!;
  const highs = swings(daily, "high");
  if (highs.length >= 2) {
    const a = highs.reduce((x, y) => (y.p > x.p ? y : x));
    const later = highs.filter((s) => s.t > a.t && s.p < a.p);
    if (later.length) {
      const b = later.reduce((x, y) => (y.p > x.p ? y : x));
      const line: TrendLine = {
        t1: a.t,
        p1: a.p,
        t2: b.t,
        p2: b.p,
        kind: "resistance",
      };
      if (last.close <= lineAt(line, last.timestamp) * 1.02) return line;
    }
  }
  const lows = swings(daily, "low");
  if (lows.length >= 2) {
    const a = lows.reduce((x, y) => (y.p < x.p ? y : x));
    const later = lows.filter((s) => s.t > a.t && s.p > a.p);
    if (later.length) {
      const b = later.reduce((x, y) => (y.p < x.p ? y : x));
      const line: TrendLine = {
        t1: a.t,
        p1: a.p,
        t2: b.t,
        p2: b.p,
        kind: "support",
      };
      if (last.close >= lineAt(line, last.timestamp) * 0.98) return line;
    }
  }
  return null;
}

/** Aggregate daily candles into JST weeks (Monday start) for
 * drawing: two years of daily bars are noise on a phone, a
 * hundred weekly bars read like the analyst charts. */
export function toWeekly(daily: readonly DailyCandle[]): DailyCandle[] {
  const weeks = new Map<string, DailyCandle>();
  for (const c of daily) {
    const d = new Date((c.timestamp + JST) * 1000);
    const monday = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    const w = weeks.get(key);
    if (!w) {
      weeks.set(key, { ...c });
    } else {
      w.high = Math.max(w.high, c.high);
      w.low = Math.min(w.low, c.low);
      w.close = c.close;
      w.volume += c.volume;
    }
  }
  return [...weeks.values()].sort((a, b) => a.timestamp - b.timestamp);
}
