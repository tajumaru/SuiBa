import { validateBook, type Book } from "./deepbook.ts";
import type { BookFeatures } from "../../shared/src/index.ts";

export interface BookAnalysis {
  version: 1;
  timestamp: number;
  evaluatedAt: number;
  bidDepthUsdc: number;
  askDepthUsdc: number;
  imbalance: number;
  spreadBps: number;
  estimates: {
    quantitySui: number;
    buyBps: number | null;
    sellBps: number | null;
  }[];
}

/** Quantities are SUI; both depth sides use the same distance from mid. */
export function analyzeBook(
  book: Book,
  now: number,
  quantities: number[],
  envelope = 0.003,
): BookFeatures {
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(envelope) ||
    envelope <= 0 ||
    envelope > 1 ||
    !quantities.length ||
    quantities.some((q) => !Number.isFinite(q) || q <= 0)
  )
    throw new Error("INVALID_BOOK_ANALYSIS_INPUT");
  const b = validateBook(
    {
      timestamp: book.timestamp,
      bids: book.bids.map((x) => x.map(String)),
      asks: book.asks.map((x) => x.map(String)),
    },
    now,
    0,
    1,
  );
  // Future snapshots are not admissible in analysis/replay, even within transport clock tolerance.
  if (b.timestamp > now) throw new Error("FUTURE_ORDERBOOK");
  const mid = (b.bid + b.ask) / 2;
  const depth = (levels: number[][]) =>
    levels
      .filter(([p]) => Math.abs(p / mid - 1) <= envelope)
      .reduce((sum, [p, q]) => sum + p * q, 0);
  const bidDepthUsdc = depth(b.bids),
    askDepthUsdc = depth(b.asks);
  if (
    ![bidDepthUsdc, askDepthUsdc].every(Number.isFinite) ||
    bidDepthUsdc + askDepthUsdc <= 0
  )
    throw new Error("INVALID_BOOK_DEPTH");
  const impact = (levels: number[][], quantity: number, buy: boolean) => {
    let remaining = quantity,
      cost = 0;
    for (const [p, q] of levels) {
      const take = Math.min(remaining, q);
      cost += take * p;
      remaining -= take;
      if (remaining <= quantity * 1e-12) break;
    }
    if (remaining > quantity * 1e-12 || !Number.isFinite(cost)) return null;
    return Math.max(
      0,
      (buy ? cost / quantity / mid - 1 : 1 - cost / quantity / mid) * 10000,
    );
  };
  return {
    version: 1,
    timestamp: b.timestamp,
    evaluatedAt: now,
    bidDepthUsdc,
    askDepthUsdc,
    imbalance: (bidDepthUsdc - askDepthUsdc) / (bidDepthUsdc + askDepthUsdc),
    spreadBps: b.spread * 10000,
    estimates: quantities.map((quantitySui) => ({
      quantitySui,
      buyBps: impact(b.asks, quantitySui, true),
      sellBps: impact(b.bids, quantitySui, false),
    })),
  };
}
