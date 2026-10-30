/**
 * The lifetime-first filled BUY in an orders list, used to mark
 * the "初約定" record in the history tab.
 *
 * The worker's history is capped at 200 rows (newest first), so
 * the earliest filled buy in the list is the lifetime first
 * only when the list is shorter than the cap — at exactly the
 * cap the true first may already have scrolled off, and no
 * mark is made rather than risk marking the wrong order.
 * Orders are per pair, so the mark is per pair as well.
 */
export interface FirstFill {
  index: number;
  amountIn: string | null;
  referencePrice: number | null;
}

const HISTORY_CAP = 200;

export function firstFilledBuy(
  orders: Record<string, unknown>[],
): FirstFill | null {
  if (orders.length >= HISTORY_CAP) return null;
  let best: { index: number; ts: number } | null = null;
  orders.forEach((o, i) => {
    if (o.side !== "BUY" || o.status !== "FILLED") return;
    const ts = typeof o.timestamp === "number" ? o.timestamp : NaN;
    if (!Number.isFinite(ts)) return;
    // The list is newest-first, so on a timestamp tie the later
    // row is the earlier order.
    if (!best || ts < best.ts || (ts === best.ts && i > best.index)) {
      best = { index: i, ts };
    }
  });
  if (!best) return null;
  const found: { index: number; ts: number } = best;
  const quote = orders[found.index].quote as
    | { amountIn?: unknown; referencePrice?: unknown }
    | undefined;
  return {
    index: found.index,
    amountIn: typeof quote?.amountIn === "string" ? quote.amountIn : null,
    referencePrice:
      typeof quote?.referencePrice === "number" ? quote.referencePrice : null,
  };
}
