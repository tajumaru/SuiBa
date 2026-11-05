import type { DailyCandle } from "../../../packages/shared/src/index.ts";

/**
 * Display-only long-term daily candles for the dashboard's
 * level map (yearly / quarterly / monthly opens and the
 * period's high and low). The discipline is btcInfo's: a
 * plain fetch on its own slow timer, beside every trading
 * path — a failure here just keeps the last good series, and
 * nothing in the trading or safety machinery can tell it
 * happened.
 *
 * Source: Coinbase's public SUI-USD daily candles. The app's
 * own venue (GeckoTerminal pools) only serves ~6 months of
 * daily history, which cannot reach a yearly open; Coinbase
 * reaches back years. The map is a landmark layer, not trade
 * data, and the dashboard labels the source on the chart.
 * SUI only — the WAL pair has no equivalent listing, so its
 * snapshot simply carries null and the map stays hidden.
 */

const DAY_SEC = 86400;
const PAGE_DAYS = 300; // Coinbase serves at most 300 buckets per request.
/** Two years of daily candles: enough for this year's and
 * last year's opens plus the trend anchors. */
export const LONG_TERM_DAYS = 730;

export function dailyCandlesUrl(
  product: string,
  startSec: number,
  endSec: number,
): string {
  const iso = (s: number) => new Date(s * 1000).toISOString();
  return `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${iso(startSec)}&end=${iso(endSec)}`;
}

/** Parse Coinbase rows [time, low, high, open, close, volume]
 * into closed daily candles, oldest first. Rows that are
 * malformed, unfinished (the running day), or non-positive
 * are dropped rather than repaired. */
export function parseDailyCandles(rows: unknown, nowSec: number): DailyCandle[] {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map<number, DailyCandle>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [time, low, high, open, close, volume] = row.map(Number);
    if (
      ![time, low, high, open, close].every(
        (n) => Number.isFinite(n) && n > 0,
      ) ||
      time + DAY_SEC > nowSec
    )
      continue;
    byTime.set(time, {
      timestamp: time,
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
    });
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchJson(url: string): Promise<unknown> {
  return Promise.race([
    (async () => {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as unknown;
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), 15000),
    ),
  ]);
}

export function createDailyCandleFetcher(
  product = "SUI-USD",
  days = LONG_TERM_DAYS,
  fetchPage: (url: string) => Promise<unknown> = fetchJson,
  now: () => number = Date.now,
): () => Promise<DailyCandle[] | null> {
  let inFlight = false;
  return async () => {
    if (inFlight) return null;
    inFlight = true;
    try {
      const nowSec = Math.floor(now() / 1000);
      const rows: unknown[] = [];
      // Walk back in 300-day pages until the span is covered.
      for (let end = nowSec; end > nowSec - days * DAY_SEC; ) {
        const start = Math.max(end - PAGE_DAYS * DAY_SEC, nowSec - days * DAY_SEC);
        const page = await fetchPage(dailyCandlesUrl(product, start, end));
        if (!Array.isArray(page)) return null;
        rows.push(...page);
        end = start;
      }
      const candles = parseDailyCandles(rows, nowSec);
      return candles.length >= 30 ? candles : null;
    } catch {
      return null;
    } finally {
      inFlight = false;
    }
  };
}

export class LongTermSampler {
  private candles: DailyCandle[] | null = null;

  /** Keep the last good series: a failed or thin fetch never
   * erases what the map already has. */
  observe(candles: DailyCandle[] | null): void {
    if (candles && candles.length >= 30) this.candles = candles;
  }

  current(): DailyCandle[] | null {
    return this.candles;
  }
}
