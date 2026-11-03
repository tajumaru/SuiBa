import {
  portfolioMixModel,
  priceText,
  signedMoney,
} from "./portfolioMix.ts";

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
}: {
  usdc: number;
  baseQty: number;
  price: number | null;
  costBasis: number;
  baseSymbol: string;
}) {
  const m = portfolioMixModel({ usdc, baseQty, price, costBasis });
  if (!m || price === null) return null;
  const money = (v: number) => v.toFixed(2);
  return (
    <section className="portfolio-mix" aria-label="資産の中身">
      <div className="pm-head">
        <span className="pm-title">資産の中身</span>
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
    </section>
  );
}
