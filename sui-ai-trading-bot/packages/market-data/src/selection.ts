import { safeFailure } from "../../shared/src/index.ts";
import type { Timeframe } from "../../shared/src/index.ts";
import { validateCandles } from "./validation.ts";
import type { Frames, MarketDataProvider, MarketStatus } from "./provider.ts";
export class MarketSelection implements MarketDataProvider {
  private selected: MarketDataProvider | null = null;
  private value: MarketStatus;
  constructor(
    readonly mode: "geckoterminal" | "deepbook" | "auto",
    private gecko: MarketDataProvider,
    private deep: MarketDataProvider & {
      prepare(now?: number): Promise<void>;
      finalize?(): Promise<void>;
      diagnostics?(): MarketStatus["diagnostics"];
      quality?(): Record<number, import("./reconstruction.ts").CandleQuality>;
      book?: {
        timestamp: number;
        bid: number;
        ask: number;
        spread: number;
      } | null;
    },
  ) {
    this.value = {
      configured: mode,
      source: null,
      fallback: false,
      lastSuccessAt: null,
      latencyMs: null,
      reason: null,
      healthy: false,
      bookAt: null,
      bid: null,
      ask: null,
      spread: null,
    };
  }
  status() {
    return {
      ...this.value,
      quality: this.deep.quality?.(),
      diagnostics: this.deep.diagnostics?.(),
    };
  }
  async candles(tf: Timeframe, now = Date.now()) {
    return (await this.frames(now))[tf];
  }
  private async collect(provider: MarketDataProvider, now: number) {
    const result: Frames = {};
    for (const tf of [300, 900, 3600] as const)
      result[tf] = validateCandles(
        await provider.candles(tf, now),
        tf,
        Date.now(),
      );
    return result;
  }
  async frames(now = Date.now()) {
    const start = Date.now();
    this.value.healthy = false;
    this.value.reason = null;
    this.selected = null;
    try {
      let frames: Frames;
      if (this.mode === "geckoterminal") {
        frames = await this.collect(this.gecko, now);
        this.selected = this.gecko;
        this.value.source = "GeckoTerminal";
        this.value.fallback = false;
      } else {
        try {
          await this.deep.prepare(now);
          frames = await this.collect(this.deep, now);
          await this.deep.finalize?.();
          this.deep.assertReady?.(Date.now());
          this.selected = this.deep;
          this.value.source = "DeepBook";
          this.value.fallback = false;
        } catch (e) {
          const reason = safeFailure(e);
          // 429, abort, pair mismatch, stale/thin/wide books must never be bypassed.
          const eligible = [
            "UPSTREAM_TIMEOUT",
            "UPSTREAM_NETWORK_FAILED",
            "UPSTREAM_DNS_FAILED",
            "UPSTREAM_HTTP_502",
            "UPSTREAM_HTTP_503",
            "UPSTREAM_HTTP_504",
            "INDEXER_DELAYED",
            "CANDLE_GAP",
            "INSUFFICIENT_CANDLES",
            "STALE_CANDLES",
          ].includes(reason);
          if (this.mode !== "auto" || !eligible) throw e;
          this.value.reason = reason;
          frames = await this.collect(this.gecko, Date.now());
          this.selected = this.gecko;
          this.value.source = "GeckoTerminal";
          this.value.fallback = true;
        }
      }
      this.value.healthy = true;
      this.value.lastSuccessAt = Date.now();
      const book = this.selected === this.deep ? this.deep.book : null;
      this.value.bookAt = book?.timestamp ?? null;
      this.value.bid = book?.bid ?? null;
      this.value.ask = book?.ask ?? null;
      this.value.spread = book?.spread ?? null;
      return frames;
    } catch (e) {
      this.value.reason = safeFailure(e);
      throw e;
    } finally {
      this.value.latencyMs = Date.now() - start;
    }
  }
  assertReady(now: number) {
    if (!this.value.healthy || !this.selected)
      throw new Error("MARKET_UNAVAILABLE");
    this.selected.assertReady?.(now);
  }
}
