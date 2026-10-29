import { tradingPairs, type TradingPair } from "../../shared/src/index.ts";
import type {
  Candle,
  CandleProvenance,
  Timeframe,
} from "../../shared/src/index.ts";
export type MarketCandle = Omit<Candle, "timeframe"> & { timeframe: number };
export interface CandleQuality {
  upstream: "DeepBook Indexer";
  pair: TradingPair;
  fetchedAt: number;
  timeframe: number;
  reconstructionMs?: number;
  originalCount?: number;
  gapTimestamps?: number[];
  unresolvedTimestamps?: number[];
  missing: number;
  reconstructed: number;
  unresolved: number;
  latestClosedAt: number | null;
  origins: Record<CandleProvenance["origin"], number>;
}
export interface EmptyTradeProof {
  source: "DeepBook Indexer";
  pair: TradingPair;
  start: number;
  end: number;
  fetchedAt: number;
  indexedThrough: number;
  complete: boolean;
  tradeCount: number;
  path: string;
}
export function gaps(c: Candle[], timeframe: Timeframe = 300): number[] {
  const result: number[] = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i].timestamp <= c[i - 1].timestamp) throw Error("INVALID_CANDLE");
    if (c[i].timestamp - c[i - 1].timestamp > timeframe * 5000)
      throw Error("CANDLE_GAP");
    for (
      let t = c[i - 1].timestamp + timeframe;
      t < c[i].timestamp;
      t += timeframe
    )
      result.push(t);
  }
  return result;
}
export function validEmptyProof(
  p: EmptyTradeProof | undefined,
  t: number,
  now: number,
  pair: TradingPair = "SUI_USDC",
  timeframe: Timeframe = 300,
): p is EmptyTradeProof {
  return (
    !!p &&
    p.source === "DeepBook Indexer" &&
    p.pair === pair &&
    p.start === t &&
    p.end === t + timeframe &&
    p.complete &&
    p.tradeCount === 0 &&
    p.indexedThrough >= (t + timeframe) * 1000 &&
    p.fetchedAt <= now &&
    now - p.fetchedAt <= 3600000 &&
    (t + timeframe) * 1000 <= now - 120000 &&
    p.path ===
      `/trades/${pair}?start_time=` +
        t +
        "&end_time=" +
        (t + timeframe) +
        "&limit=1000"
  );
}
function validateMinute(x: MarketCandle, now: number, pair: TradingPair) {
  if (
    x.timeframe !== 60 ||
    x.timestamp % 60 ||
    (x.timestamp + 60) * 1000 > now ||
    !x.source.startsWith(`DeepBook:${pair}:USDC`) ||
    ![x.timestamp, x.open, x.high, x.low, x.close, x.volume].every(
      Number.isFinite,
    ) ||
    Math.min(x.open, x.high, x.low, x.close) <= 0 ||
    x.volume < 0 ||
    x.low > Math.min(x.open, x.close) ||
    x.high < Math.max(x.open, x.close) ||
    x.low > x.high
  )
    throw Error("INVALID_CANDLE");
}
export function reconstructCandles(
  raw: Candle[],
  minutes: MarketCandle[],
  proofs: Map<number, EmptyTradeProof>,
  now: number,
  fetchedAt = now,
  pair: TradingPair = "SUI_USDC",
  timeframe: Timeframe = 300,
) {
  if (
    raw.some(
      (x) =>
        x.timeframe !== timeframe ||
        x.timestamp % timeframe ||
        !x.source.startsWith(`DeepBook:${pair}:USDC`),
    )
  )
    throw Error("INVALID_CANDLE");
  const missing = gaps(raw, timeframe),
    byMinute = new Map<number, MarketCandle>();
  for (const x of minutes) {
    validateMinute(x, now, pair);
    if (byMinute.has(x.timestamp)) throw Error("INVALID_CANDLE");
    byMinute.set(x.timestamp, x);
  }
  const source = `DeepBook:${pair}:USDC:verified-v1`,
    result: Candle[] = [];
  const original = new Map(raw.map((x) => [x.timestamp, x]));
  if (raw.length)
    for (let t = raw[0].timestamp; t <= raw.at(-1)!.timestamp; t += timeframe) {
      const x = original.get(t);
      if (x) {
        result.push({
          ...x,
          source,
          provenance: x.provenance ?? {
            origin: "ORIGINAL",
            upstream: "DeepBook Indexer",
            pair,
            fetchedAt,
            timeframe,
            evidence: [
              `/ohclv/${pair}?interval=${timeframe === 300 ? "5m" : timeframe === 900 ? "15m" : "1h"}&limit=${tradingPairs[pair].candleLimit}`,
            ],
          },
        });
        continue;
      }
      const parts = Array.from({ length: timeframe / 60 }, (_, i) =>
          byMinute.get(t + i * 60),
        ),
        present = parts.filter((x): x is MarketCandle => !!x);
      if (
        present.length === timeframe / 60 &&
        present.every((x) => x.source === present[0].source)
      ) {
        result.push({
          timestamp: t,
          timeframe,
          source,
          open: present[0].open,
          high: Math.max(...present.map((x) => x.high)),
          low: Math.min(...present.map((x) => x.low)),
          close: present.at(-1)!.close,
          volume: present.reduce((n, x) => n + x.volume, 0),
          provenance: {
            origin: "ONE_MINUTE_AGGREGATE",
            upstream: "DeepBook Indexer",
            pair,
            fetchedAt,
            timeframe,
            evidence: present.map((x) => "1m:" + x.timestamp),
          },
        });
      } else if (
        !present.length &&
        validEmptyProof(proofs.get(t), t, now, pair, timeframe) &&
        result.at(-1)?.timestamp === t - timeframe
      ) {
        const previous = result.at(-1)!,
          proof = proofs.get(t)!;
        result.push({
          timestamp: t,
          timeframe,
          source,
          open: previous.close,
          high: previous.close,
          low: previous.close,
          close: previous.close,
          volume: 0,
          provenance: {
            origin: "NO_INDEXED_TRADES",
            upstream: "DeepBook Indexer",
            pair,
            fetchedAt: proof.fetchedAt,
            timeframe,
            evidence: [
              proof.path,
              "order_fill.indexedThrough:" + proof.indexedThrough,
              "complete-empty-response; independent-chain-audit:not-performed",
            ],
          },
        });
      }
    }
  const origins: CandleQuality["origins"] = {
    ORIGINAL: 0,
    ONE_MINUTE_AGGREGATE: 0,
    NO_INDEXED_TRADES: 0,
  };
  for (const x of result) origins[x.provenance!.origin]++;
  const unresolved = gaps(result, timeframe).length;
  return {
    candles: result,
    quality: {
      upstream: "DeepBook Indexer" as const,
      pair,
      fetchedAt,
      timeframe,
      missing: missing.length,
      reconstructed: origins.ONE_MINUTE_AGGREGATE + origins.NO_INDEXED_TRADES,
      unresolved,
      unresolvedTimestamps: gaps(result, timeframe),
      latestClosedAt: result.length
        ? (result.at(-1)!.timestamp + timeframe) * 1000
        : null,
      origins,
    },
  };
}

/** Compatibility wrapper for existing SUI five-minute reconstruction callers. */
export function reconstructFiveMinutes(
  raw: Candle[],
  minutes: MarketCandle[],
  proofs: Map<number, EmptyTradeProof>,
  now: number,
  fetchedAt = now,
  pair: TradingPair = "SUI_USDC",
) {
  return reconstructCandles(raw, minutes, proofs, now, fetchedAt, pair, 300);
}
