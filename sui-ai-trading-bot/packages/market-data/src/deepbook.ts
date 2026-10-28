import { deepBookTransport } from "./deepbook-transport.ts";
import { withReadBudget } from "../../shared/src/read-budget-node.ts";
import { abortable, currentReadBudget } from "../../shared/src/read-budget.ts";
import {
  gaps,
  reconstructFiveMinutes,
  validEmptyProof,
  type EmptyTradeProof,
  type CandleQuality,
  type MarketCandle,
} from "./reconstruction.ts";
import { z } from "zod";
import { apiFetch } from "../../shared/src/api.ts";
import {
  coin,
  tradingPairs,
  type TradingPair,
  USDC,
  type Candle,
  type Timeframe,
} from "../../shared/src/index.ts";
import { validateCandles } from "./validation.ts";
const base = "https://deepbook-indexer.mainnet.mystenlabs.com";
const row = z.tuple([
  z.number().int().positive(),
  ...Array.from({ length: 5 }, () => z.number().finite()),
] as [
  z.ZodNumber,
  z.ZodNumber,
  z.ZodNumber,
  z.ZodNumber,
  z.ZodNumber,
  z.ZodNumber,
]);
export function parseDeepBook(
  raw: unknown,
  tf: number,
  now: number,
  pair: TradingPair = "SUI_USDC",
): MarketCandle[] {
  const rows = z.object({ candles: z.array(row) }).parse(raw).candles;
  const ms = (rows[0]?.[0] ?? 0) >= 1e12;
  if (rows.some((r) => r[0] >= 1e12 !== ms)) throw new Error("INVALID_CANDLE");
  const c = rows
    .map(([timestamp, open, high, low, close, volume]) => ({
      timestamp: ms ? timestamp / 1000 : timestamp,
      open,
      high,
      low,
      close,
      volume,
      timeframe: tf,
      source: `DeepBook:${pair}:USDC`,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
  // Check malformed and future bars before excluding the current unfinished bar.
  for (const x of c)
    if (
      !Number.isInteger(x.timestamp) ||
      x.timestamp % tf ||
      x.timestamp > now / 1000 ||
      Math.min(x.open, x.high, x.low, x.close) <= 0 ||
      x.volume < 0 ||
      x.low > Math.min(x.open, x.close) ||
      x.high < Math.max(x.open, x.close) ||
      x.low > x.high
    )
      throw new Error("INVALID_CANDLE");
  const closed = c.filter((x) => (x.timestamp + tf) * 1000 <= now);
  if (new Set(closed.map((x) => x.timestamp)).size !== closed.length)
    throw new Error("INVALID_CANDLE");
  return closed;
}
export function normalizeDeepBook(
  raw: unknown,
  tf: Timeframe,
  now: number,
): Candle[] {
  return validateCandles(parseDeepBook(raw, tf, now) as Candle[], tf, now);
}

const level = z.tuple([z.string().min(1), z.string().min(1)]);
export interface Book {
  timestamp: number;
  bid: number;
  ask: number;
  spread: number;
  bids: number[][];
  asks: number[][];
}
export function validateBook(
  raw: unknown,
  now: number,
  notional: number,
  maxSpread: number,
): Book {
  const r = z
    .object({
      timestamp: z.union([z.string(), z.number()]),
      bids: z.array(level).min(1),
      asks: z.array(level).min(1),
    })
    .parse(raw);
  const timestamp = Number(r.timestamp),
    bids = r.bids.map((x) => x.map(Number)),
    asks = r.asks.map((x) => x.map(Number));
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now + 5000 ||
    now - timestamp > 10000
  )
    throw new Error("STALE_ORDERBOOK");
  for (const levels of [bids, asks])
    if (levels.some((x) => x.some((v) => !Number.isFinite(v) || v <= 0)))
      throw new Error("INVALID_ORDERBOOK");
  if (
    bids.some((x, i) => i > 0 && x[0] >= bids[i - 1][0]) ||
    asks.some((x, i) => i > 0 && x[0] <= asks[i - 1][0])
  )
    throw new Error("INVALID_ORDERBOOK");
  const bid = bids[0][0],
    ask = asks[0][0],
    mid = (bid + ask) / 2,
    spread = (ask - bid) / mid;
  if (spread <= 0) throw new Error("INVALID_ORDERBOOK");
  if (spread > maxSpread) throw new Error("SPREAD_TOO_WIDE");
  // Both directions must cover maxOrder within the configured slippage envelope.
  for (const [levels, buy] of [
    [asks, true],
    [bids, false],
  ] as const) {
    const depth = levels
      .filter((x) => Math.abs(x[0] / mid - 1) <= maxSpread)
      .reduce((n, x) => n + x[0] * x[1], 0);
    if (depth < notional) throw new Error("THIN_ORDERBOOK");
  }
  return { timestamp, bid, ask, spread, bids, asks };
}
/** Same-response evidence, including books rejected by the safety gate. No rescaling. */
export function bookObservation(
  raw: unknown,
  fetchedAt: number,
  maxSpread: number,
) {
  const parsed = z
    .object({
      timestamp: z.union([z.string(), z.number()]),
      bids: z.array(level).min(1),
      asks: z.array(level).min(1),
    })
    .safeParse(raw);
  if (!parsed.success) return null;
  const timestamp = Number(parsed.data.timestamp),
    bid = Number(parsed.data.bids[0][0]),
    ask = Number(parsed.data.asks[0][0]);
  if (![timestamp, bid, ask].every(Number.isFinite) || bid <= 0 || ask <= 0)
    return null;
  return {
    timestamp,
    fetchedAt,
    bid,
    ask,
    spread: (ask - bid) / ((ask + bid) / 2),
    maxSpread,
  };
}
type ReadJson = (path: string, ttl?: number) => Promise<unknown>;
export class DeepBookMarketData {
  book: Book | null = null;
  bookParams: { minSize: string; lotSize: string; tickSize: string } | null =
    null;
  private bookRaw: unknown;
  private bookFetchedAt = 0;
  private qualities: Record<number, CandleQuality> = {};
  private proofs = new Map<number, EmptyTradeProof>();

  private indexedThrough = 0;
  private refreshAfterCandles = false;
  private indexerLagMs: number | null = null;
  diagnostics() {
    const mid = this.book ? (this.book.bid + this.book.ask) / 2 : 0;
    const depth = (levels: number[][] | undefined) =>
      levels
        ? levels
            .filter(
              (x) => Math.abs(x[0] / mid - 1) <= this.limits().maxSlippage,
            )
            .reduce((n, x) => n + x[0] * x[1], 0)
        : null;
    return {
      bookObservation: bookObservation(
        this.bookRaw,
        this.bookFetchedAt,
        this.limits().maxSlippage,
      ),
      indexerLagMs: this.indexerLagMs,
      indexedThrough: this.indexedThrough,
      bidDepthUsdc: depth(this.book?.bids),
      askDepthUsdc: depth(this.book?.asks),
    };
  }
  quality() {
    return structuredClone(this.qualities);
  }
  constructor(
    private limits: () => { maxOrder: number; maxSlippage: number },
    private read: ReadJson = async (path, ttl = 0) =>
      (
        await apiFetch(
          "DeepBook Indexer",
          base + path,
          { headers: { accept: "application/json" } },
          ttl,
          {
            timeoutMs: 8000,
            maxTransientRetries: 2,
            transport: deepBookTransport.fetch,
          },
        )
      ).json(),
    private reconstruct = false,
    readonly pair: TradingPair = "SUI_USDC",
  ) {}
  async prepare(now = Date.now()) {
    const pools = z
      .array(
        z.object({
          pool_name: z.string(),
          pool_id: z.string().optional(),
          min_size: z.number().int().positive().optional(),
          lot_size: z.number().int().positive().optional(),
          tick_size: z.number().int().positive().optional(),
          base_asset_id: z.string(),
          quote_asset_id: z.string(),
          base_asset_decimals: z.number(),
          quote_asset_decimals: z.number(),
        }),
      )
      .parse(await this.checkedRead("/get_pools", 300000));
    const p = pools.find((p) => p.pool_name === this.pair);
    if (
      !p ||
      (p.pool_id !== undefined &&
        p.pool_id !== tradingPairs[this.pair].poolId) ||
      (this.pair === "WAL_USDC" &&
        (!p.pool_id || !p.min_size || !p.lot_size || !p.tick_size)) ||
      coin(p.base_asset_id) !== tradingPairs[this.pair].base ||
      coin(p.quote_asset_id) !== USDC ||
      p.base_asset_decimals !== 9 ||
      p.quote_asset_decimals !== 6
    )
      throw new Error("MARKET_PAIR_MISMATCH");
    if (p.min_size && p.lot_size && p.tick_size)
      this.bookParams = {
        minSize: String(p.min_size),
        lotSize: String(p.lot_size),
        tickSize: String(p.tick_size),
      };
    await this.refresh();
  }
  private async refreshStatus() {
    const status = z
      .object({
        status: z.string(),
        current_time_ms: z.number(),
        max_checkpoint_lag: z.number(),
        max_time_lag_seconds: z.number(),
        pipelines: z
          .array(
            z.object({
              pipeline: z.string(),
              indexed_timestamp_ms: z.number(),
              is_backfill: z.boolean().optional(),
            }),
          )
          .optional(),
      })
      .parse(
        await this.checkedRead(
          "/status?max_checkpoint_lag=100&max_time_lag_seconds=60",
          5000,
        ),
      );
    const checked = Date.now();
    this.indexerLagMs = status.max_time_lag_seconds * 1000;
    if (
      status.status !== "OK" ||
      status.max_checkpoint_lag > 100 ||
      status.max_time_lag_seconds > 60 ||
      Math.abs(checked - status.current_time_ms) > 10000
    )
      throw new Error("INDEXER_DELAYED");
    this.indexedThrough =
      status.pipelines?.find(
        (p) => p.pipeline === "order_fill" && !p.is_backfill,
      )?.indexed_timestamp_ms ?? 0;
  }
  private async refresh() {
    await this.refreshStatus();
    this.bookRaw = await this.checkedRead(
      `/orderbook/${this.pair}?level=2&depth=10`,
    );
    this.bookFetchedAt = Date.now();
    this.assertReady(this.bookFetchedAt);
  }
  async refreshForOrder() {
    await this.refresh();
  }
  async finalize() {
    // Avoid duplicate reads on short cycles; long/recovery/reconstruction cycles finish fresh.
    if (
      this.refreshAfterCandles ||
      currentReadBudget()?.fresh ||
      !this.book ||
      Date.now() - this.book.timestamp > 5000
    ) {
      await this.refresh();
      this.refreshAfterCandles = false;
    }
    this.assertReady(Date.now());
  }
  assertReady(now: number) {
    const limits = this.limits();
    this.book = validateBook(
      this.bookRaw,
      now,
      limits.maxOrder,
      limits.maxSlippage,
    );
  }
  private async checkedRead(path: string, ttl = 0) {
    const budget = currentReadBudget();
    budget?.signal.throwIfAborted();
    const result = await this.read(path, ttl);
    budget?.signal.throwIfAborted();
    return result;
  }
  async candles(tf: Timeframe, now = Date.now()) {
    const parent = currentReadBudget(),
      controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(parent ? [parent.signal] : []),
    ]);
    const began = performance.now();
    const timer = setTimeout(
      () => controller.abort(new Error("CANDLE_GAP")),
      45000,
    );
    timer.unref?.();
    try {
      return await withReadBudget(signal, parent?.fresh ?? false, async () => {
        const result = await abortable(this.readCandles(tf, now), signal);
        signal.throwIfAborted();
        if (performance.now() - began > 45000) throw new Error("CANDLE_GAP");
        return result;
      });
    } finally {
      clearTimeout(timer);
    }
  }
  private async readCandles(tf: Timeframe, now: number) {
    const interval = tf === 300 ? "5m" : tf === 900 ? "15m" : "1h",
      began = Date.now();
    const raw = await this.checkedRead(
      `/ohclv/${this.pair}?interval=${interval}&limit=${tradingPairs[this.pair].candleLimit}`,
      20000,
    );
    const c = parseDeepBook(
      raw,
      tf,
      Math.max(now, Date.now()),
      this.pair,
    ) as Candle[];
    const holes = tf === 300 ? gaps(c) : [];
    const missingCount =
      tf === 300
        ? holes.length
        : c
            .slice(1)
            .reduce(
              (n, x, i) =>
                n + Math.max(0, (x.timestamp - c[i].timestamp) / tf - 1),
              0,
            );
    let quality: CandleQuality = {
      upstream: "DeepBook Indexer",
      pair: this.pair,
      fetchedAt: Date.now(),
      timeframe: tf,
      originalCount: c.length,
      gapTimestamps: holes,
      unresolvedTimestamps: holes,
      reconstructionMs: 0,
      missing: missingCount,
      reconstructed: 0,
      unresolved: missingCount,
      latestClosedAt: c.length ? (c.at(-1)!.timestamp + tf) * 1000 : null,
      origins: {
        ORIGINAL: c.length,
        ONE_MINUTE_AGGREGATE: 0,
        NO_INDEXED_TRADES: 0,
      },
    };
    this.qualities[tf] = quality;
    if (this.reconstruct && tf === 300 && holes.length) {
      this.refreshAfterCandles = true;
      const reconstructionStarted = Date.now();
      try {
        // Reuse still-valid empty proofs; never reuse unproven missing intervals.
        if (holes.length > 64) throw new Error("CANDLE_GAP");
        const minutes: MarketCandle[] = [];
        let cursor = (c.at(-1)!.timestamp + 300) * 1000 - 1000;
        const needsMinutes = holes.some(
          (t) => !validEmptyProof(this.proofs.get(t), t, Date.now(), this.pair),
        );
        for (let page = 0; needsMinutes && page < 8; page++) {
          if (Date.now() - began > 45000) throw new Error("CANDLE_GAP");
          const rows = parseDeepBook(
            await this.checkedRead(
              `/ohclv/${this.pair}?interval=1m&start_time=` +
                c[0].timestamp * 1000 +
                "&end_time=" +
                cursor +
                "&limit=1000",
              20000,
            ),
            60,
            Date.now(),
            this.pair,
          );
          minutes.push(...rows);
          if (rows.length < 1000) break;
          const earliest = rows[0].timestamp * 1000;
          if (earliest >= cursor) throw new Error("INVALID_CANDLE");
          cursor = earliest - 1000;
          if (cursor < c[0].timestamp * 1000) break;
          if (page === 7) throw new Error("CANDLE_GAP");
        }
        await this.refreshStatus();
        const indexedThrough = this.indexedThrough;
        for (const t of holes) {
          if (Date.now() - began > 45000) break;
          if (minutes.some((x) => x.timestamp >= t && x.timestamp < t + 300))
            continue;
          if (validEmptyProof(this.proofs.get(t), t, Date.now(), this.pair))
            continue;
          if (
            (t + 300) * 1000 > Date.now() - 120000 ||
            indexedThrough < (t + 300) * 1000
          )
            continue;
          const path =
            `/trades/${this.pair}?start_time=` +
            t +
            "&end_time=" +
            (t + 300) +
            "&limit=1000";
          const trades = z
            .array(z.object({ timestamp: z.number().int().positive() }))
            .parse(await this.checkedRead(path));
          if (
            trades.some(
              (x) => x.timestamp < t * 1000 || x.timestamp > (t + 300) * 1000,
            )
          )
            throw new Error("INVALID_CANDLE");
          this.proofs.set(t, {
            source: "DeepBook Indexer",
            pair: this.pair,
            start: t,
            end: t + 300,
            fetchedAt: Date.now(),
            indexedThrough,
            complete: trades.length < 1000,
            tradeCount: trades.filter((x) => x.timestamp < (t + 300) * 1000)
              .length,
            path,
          });
        }
        for (const [t, p] of this.proofs)
          if (Date.now() - p.fetchedAt > 3600000) this.proofs.delete(t);
        const result = reconstructFiveMinutes(
          c,
          minutes,
          this.proofs,
          Date.now(),
          quality.fetchedAt,
          this.pair,
        );
        quality = {
          ...result.quality,
          originalCount: c.length,
          gapTimestamps: holes,
        };
        this.qualities[tf] = quality;
        currentReadBudget()?.signal.throwIfAborted();
        return validateCandles(result.candles, tf, Date.now());
      } finally {
        quality.reconstructionMs = Date.now() - reconstructionStarted;
      }
    }
    const original = c.map((x) => ({
      ...x,
      source: this.reconstruct
        ? `DeepBook:${this.pair}:USDC:verified-v1`
        : x.source,
      provenance: {
        origin: "ORIGINAL" as const,
        upstream: "DeepBook Indexer" as const,
        pair: this.pair,
        fetchedAt: quality.fetchedAt,
        timeframe: tf,
        evidence: [
          `/ohclv/${this.pair}?interval=${interval}&limit=${tradingPairs[this.pair].candleLimit}`,
        ],
      },
    }));
    return validateCandles(original, tf, Date.now());
  }
}
