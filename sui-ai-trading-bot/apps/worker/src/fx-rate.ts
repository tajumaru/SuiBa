/** Display-only USD/JPY rate. It never enters trading or safety decisions. */
const USD_JPY_URL = "https://api.frankfurter.app/latest?from=USD&to=JPY";

export interface FxRate {
  usdJpy: number;
  asOf: number;
}

export function createUsdJpyFetcher(
  url = USD_JPY_URL,
): () => Promise<number | null> {
  let inFlight = false;
  return async () => {
    if (inFlight) return null;
    inFlight = true;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetch(url, {
            headers: { accept: "application/json" },
          });
          if (!response.ok) return null;
          const body = (await response.json()) as {
            rates?: { JPY?: unknown };
          };
          const rate = body.rates?.JPY;
          return typeof rate === "number" && Number.isFinite(rate) && rate > 0
            ? rate
            : null;
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

export class FxRateSampler {
  private latest: FxRate | null = null;

  observe(usdJpy: number, now = Date.now()): FxRate | null {
    if (!Number.isFinite(usdJpy) || usdJpy <= 0) return this.latest;
    this.latest = { usdJpy, asOf: now };
    return this.latest;
  }

  current(): FxRate | null {
    return this.latest;
  }
}
