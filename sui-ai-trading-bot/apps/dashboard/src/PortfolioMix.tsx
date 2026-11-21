import {
  portfolioMixModel,
  priceText,
  signedMoney,
} from "./portfolioMix.ts";
import { JpyAmount } from "./JpyAmount.tsx";

/**
 * "資産の中身" — the overview block under the cards that shows
 * what the total is made of: a bar split between cash (USDC)
 * and the base asset at the current price, and the arithmetic
 * underneath (quantity × price = value, against the cost).
 * Buys convert cash into the asset without moving the total;
 * the price moves the asset slice afterwards. Renders
 * nothing until a price exists to value the holding with.
 */
export function PortfolioMix({
  usdc,
  baseQty,
  price,
  costBasis,
  baseSymbol,
  usdJpy = null,
  embedded = false,
}: {
  usdc: number;
  baseQty: number;
  price: number | null;
  costBasis: number;
  baseSymbol: string;
  usdJpy?: number | null;
  /** Inside the merged 資産 card (2026-11-22): the outer card
   * carries the panel frame, so this renders bare with the
   * shorter title. */
  embedded?: boolean;
}) {
  const m = portfolioMixModel({ usdc, baseQty, price, costBasis });
  if (!m || price === null) return null;
  const money = (v: number) => v.toFixed(2);
  const body = (
    <>
      <div className="pm-head">
        <span className="pm-title">{embedded ? "資産" : "資産の中身"}</span>
        <span className="pm-total">
          合計 <b>{money(m.total)} USDC</b>
        </span>
      </div>
      <div className="pm-bar" aria-hidden="true">
        <div className="pm-usdc" style={{ width: `${m.usdcPct}%` }}>
          {m.usdcPct > 22 ? `USDC ${money(m.usdc)}` : ""}
        </div>
        <div className="pm-base" style={{ width: `${m.basePct}%` }}>
          {m.basePct > 14 ? `${baseSymbol} ${money(m.baseValue)}` : ""}
        </div>
      </div>
      <div className="pm-rows">
        <div>
          <span className="pm-k">USDC</span> {money(m.usdc)}（現金）
        </div>
        <div>
          <span className="pm-k">{baseSymbol}</span>{" "}
          {m.baseQty > 0 ? (
            <>
              {money(m.baseQty)} 枚 × ${priceText(price)} ={" "}
              <span className="pm-eq">{money(m.baseValue)} USDC</span>
              <JpyAmount usdc={m.baseValue} usdJpy={usdJpy} />
              {m.gain !== null && (
                <>
                  （取得 {money(m.costBasis)} →{" "}
                  <span className={m.gain >= 0 ? "pm-up" : "pm-down"}>
                    {signedMoney(m.gain)}
                  </span>
                  ）
                </>
              )}
            </>
          ) : (
            "0.00 枚"
          )}
        </div>
      </div>
    </>
  );
  if (embedded) return <div className="portfolio-mix-embedded">{body}</div>;
  return (
    <section className="portfolio-mix" aria-label="資産の中身">
      {body}
    </section>
  );
}
