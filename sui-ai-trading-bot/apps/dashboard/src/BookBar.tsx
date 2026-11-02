/**
 * The DeepBook order book's lean for the current pair, as one
 * slim bar under the chain strip. The number is the same
 * imbalance that leans the model outlook (worker snapshot,
 * display only): within ±1% of the mid, how the bid and ask
 * notionals split. The bar grows from the centre — mint to
 * the right when bids outweigh asks, rose to the left when
 * asks outweigh bids. Renders nothing until a sample exists.
 */
export interface BookBarModel {
  /** Share of in-band notional on the bid side, 0..100. */
  bidPct: number;
  askPct: number;
  side: "buy" | "sell" | "even";
  sideWord: string;
  /** Bar fill from the centre, 0..50 (percent of the track). */
  fillPct: number;
}

export function bookBarModel(imbalance: number): BookBarModel {
  const v = Math.max(-1, Math.min(1, imbalance));
  const bidPct = Math.round(((1 + v) / 2) * 100);
  const side = v > 0.05 ? "buy" : v < -0.05 ? "sell" : "even";
  return {
    bidPct,
    askPct: 100 - bidPct,
    side,
    sideWord: side === "buy" ? "買い優勢" : side === "sell" ? "売り優勢" : "均衡",
    fillPct: Math.abs(v) * 50,
  };
}

export function BookBar({ imbalance }: { imbalance: number | null }) {
  if (imbalance == null || !Number.isFinite(imbalance)) return null;
  const m = bookBarModel(imbalance);
  return (
    <div className="book-bar" aria-label="板の偏り">
      <span className="book-bar-label">板</span>
      <span className="book-bar-side sell">売り {m.askPct}%</span>
      <span className="book-bar-track" aria-hidden="true">
        <span className="book-bar-center" />
        {m.side !== "even" && (
          <span
            className={`book-bar-fill ${m.side}`}
            style={
              m.side === "buy"
                ? { left: "50%", width: `${m.fillPct}%` }
                : { right: "50%", width: `${m.fillPct}%` }
            }
          />
        )}
      </span>
      <span className="book-bar-side buy">買い {m.bidPct}%</span>
      <strong className={`book-bar-word ${m.side}`}>{m.sideWord}</strong>
    </div>
  );
}
