import {
  bookImbalance,
  bookTopLevels,
} from "../../../packages/market-data/src/deepbook.ts";
import type {
  BookLevels,
  TradingPair,
} from "../../../packages/shared/src/index.ts";

/**
 * Display-only order-book imbalance sampling for pairs whose
 * trading path does not fetch the DeepBook book (the SUI pair's
 * default GeckoTerminal route). Like chainInfo.ts, this is a
 * fully separate read: a plain fetch against the public
 * DeepBook indexer that never goes through the trading client's
 * apiAccess layer, never throws, and whose only consumer is
 * the dashboard snapshot. It must stay that way — wiring this
 * into any trading or safety path would couple a decorative
 * number to the bot's health gates.
 */
const INDEXER = "https://deepbook-indexer.mainnet.mystenlabs.com";
/** A sample stays usable for the outlook for this long. */
export const BOOK_IMBALANCE_FRESH_MS = 120000;

/** One sampled book: the imbalance for the outlook plus the
 * top levels for the narration's wall watch. */
export interface BookSample {
  imbalance: number | null;
  levels: BookLevels;
}

export class BookImbalanceSampler {
  private value: number | null = null;
  private levels: BookLevels | null = null;
  private at = 0;
  observe(value: number | null, now = Date.now()): void {
    if (value == null) return;
    this.value = value;
    this.at = now;
  }
  observeSample(sample: BookSample | null, now = Date.now()): void {
    if (!sample) return;
    if (sample.imbalance != null) this.value = sample.imbalance;
    this.levels = sample.levels;
    this.at = now;
  }
  current(now = Date.now()): number | null {
    if (this.value == null || now - this.at > BOOK_IMBALANCE_FRESH_MS)
      return null;
    return this.value;
  }
  /** The latest sampled top-of-book levels, under the same
   * freshness rule as the imbalance. */
  currentLevels(now = Date.now()): BookLevels | null {
    if (this.levels == null || now - this.at > BOOK_IMBALANCE_FRESH_MS)
      return null;
    return this.levels;
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** One book read for a pair, or null on any failure. The
 * indexer response is parsed by hand (levels of [price, qty]
 * strings) and freshness-checked loosely — this read feeds a
 * labelled model outlook and the narration's wall watch, not a
 * safety gate, so it accepts a book up to 60 seconds old. */
function createBookSampleFetcherCore(
  pair: TradingPair,
  fetchFn: FetchFn,
): () => Promise<BookSample | null> {
  let inFlight = false;
  return async () => {
    if (inFlight) return null;
    inFlight = true;
    try {
      const res = await fetchFn(
        `${INDEXER}/orderbook/${pair}?level=2&depth=100`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) return null;
      const raw = (await res.json()) as {
        timestamp?: unknown;
        bids?: unknown;
        asks?: unknown;
      };
      const timestamp = Number(raw?.timestamp);
      if (
        !Number.isFinite(timestamp) ||
        Date.now() - timestamp > 60000 ||
        timestamp > Date.now() + 5000
      )
        return null;
      const levels = (side: unknown): number[][] | null => {
        if (!Array.isArray(side)) return null;
        const out: number[][] = [];
        for (const level of side) {
          if (!Array.isArray(level) || level.length < 2) return null;
          const price = Number(level[0]),
            qty = Number(level[1]);
          if (!Number.isFinite(price) || !Number.isFinite(qty)) return null;
          out.push([price, qty]);
        }
        return out;
      };
      const bids = levels(raw?.bids),
        asks = levels(raw?.asks);
      if (!bids || !asks) return null;
      return {
        imbalance: bookImbalance({ bids, asks }),
        levels: { at: timestamp, ...bookTopLevels({ bids, asks }) },
      };
    } catch {
      return null;
    } finally {
      inFlight = false;
    }
  };
}

/** One imbalance read for a pair, or null on any failure. */
export function createBookImbalanceFetcher(
  pair: TradingPair,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): () => Promise<number | null> {
  const core = createBookSampleFetcherCore(pair, fetchFn);
  return async () => (await core())?.imbalance ?? null;
}

/** One full book sample (imbalance + top levels) for a pair,
 * or null on any failure. */
export function createBookSampleFetcher(
  pair: TradingPair,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): () => Promise<BookSample | null> {
  return createBookSampleFetcherCore(pair, fetchFn);
}
