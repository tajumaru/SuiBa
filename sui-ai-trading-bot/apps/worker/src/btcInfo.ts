import type { BtcInfo } from "../../../packages/shared/src/index.ts";

/**
 * Display-only BTC/USD sampling for the narration's market
 * weather. A plain fetch on its own timer, beside every
 * trading path — the chainInfo discipline: a failure here is
 * just a frozen (then stale) sample, and nothing in the
 * trading or safety machinery can tell it happened. BTC is
 * ambience for the character's mutters, never an input.
 */

const TICKER_URL = "https://api.exchange.coinbase.com/products/BTC-USD/ticker";
const HOUR_MS = 3600 * 1000;
/** Samples kept: enough to always have an hour-ago reference. */
const KEEP_MS = 3 * HOUR_MS;

export function createBtcPriceFetcher(
  url = TICKER_URL,
): () => Promise<number | null> {
  let inFlight = false;
  return async () => {
    if (inFlight) return null;
    inFlight = true;
    try {
      return await Promise.race([
        (async () => {
          const res = await fetch(url, {
            headers: { accept: "application/json" },
          });
          if (!res.ok) return null;
          const body = (await res.json()) as { price?: unknown };
          const price =
            typeof body.price === "string"
              ? Number(body.price)
              : typeof body.price === "number"
                ? body.price
                : Number.NaN;
          return Number.isFinite(price) && price > 0 ? price : null;
        })(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
      ]);
    } catch {
      return null;
    } finally {
      inFlight = false;
    }
  };
}

export class BtcSampler {
  private samples: { price: number; at: number }[] = [];
  private latest: BtcInfo | null = null;

  observe(price: number, now = Date.now()): BtcInfo {
    this.samples = [
      ...this.samples.filter((s) => now - s.at <= KEEP_MS),
      { price, at: now },
    ];
    // The reference is the newest sample at or before an hour
    // ago; without one (the sampler's first hour) the change
    // stays unknown rather than approximated from less.
    let reference: { price: number; at: number } | null = null;
    for (const s of this.samples) {
      if (s.at <= now - HOUR_MS) reference = s;
      else break;
    }
    this.latest = {
      price,
      change1hPct:
        reference != null
          ? ((price - reference.price) / reference.price) * 100
          : null,
      at: now,
    };
    return this.latest;
  }

  current(): BtcInfo | null {
    return this.latest;
  }
}
