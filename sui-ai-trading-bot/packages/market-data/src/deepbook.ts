import { z } from "zod";
import { apiFetch } from "../../shared/src/api.ts";
import {
  coin,
  SUI,
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
export function normalizeDeepBook(
  raw: unknown,
  tf: Timeframe,
  now: number,
): Candle[] {
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
      source: "DeepBook:SUI_USDC:USDC",
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
  return validateCandles(
    c.filter((x) => (x.timestamp + tf) * 1000 <= now),
    tf,
    now,
  );
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
type ReadJson = (path: string, ttl?: number) => Promise<unknown>;
export class DeepBookMarketData {
  book: Book | null = null;
  private bookRaw: unknown;
  constructor(
    private limits: () => { maxOrder: number; maxSlippage: number },
    private read: ReadJson = async (path, ttl = 0) =>
      (
        await apiFetch(
          "DeepBook Indexer",
          base + path,
          { headers: { accept: "application/json" } },
          ttl,
          { timeoutMs: 8000, maxTransientRetries: 2 },
        )
      ).json(),
  ) {}
  async prepare(now = Date.now()) {
    const pools = z
      .array(
        z.object({
          pool_name: z.string(),
          base_asset_id: z.string(),
          quote_asset_id: z.string(),
          base_asset_decimals: z.number(),
          quote_asset_decimals: z.number(),
        }),
      )
      .parse(await this.read("/get_pools", 300000));
    const p = pools.find((p) => p.pool_name === "SUI_USDC");
    if (
      !p ||
      coin(p.base_asset_id) !== SUI ||
      coin(p.quote_asset_id) !== USDC ||
      p.base_asset_decimals !== 9 ||
      p.quote_asset_decimals !== 6
    )
      throw new Error("MARKET_PAIR_MISMATCH");
    const status = z
      .object({
        status: z.string(),
        current_time_ms: z.number(),
        max_checkpoint_lag: z.number(),
        max_time_lag_seconds: z.number(),
      })
      .parse(
        await this.read(
          "/status?max_checkpoint_lag=100&max_time_lag_seconds=60",
          5000,
        ),
      );
    const checked = Date.now();
    if (
      status.status !== "OK" ||
      status.max_checkpoint_lag > 100 ||
      status.max_time_lag_seconds > 60 ||
      Math.abs(checked - status.current_time_ms) > 10000
    )
      throw new Error("INDEXER_DELAYED");
    this.bookRaw = await this.read("/orderbook/SUI_USDC?level=2&depth=10");
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
  async candles(tf: Timeframe, now = Date.now()) {
    const interval = tf === 300 ? "5m" : tf === 900 ? "15m" : "1h";
    return normalizeDeepBook(
      await this.read(
        "/ohclv/SUI_USDC?interval=" + interval + "&limit=1000",
        20000,
      ),
      tf,
      Math.max(now, Date.now()),
    );
  }
}
