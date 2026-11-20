import type { BotSnapshot } from "../../worker/src/engine.ts";

const quantity = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 9 });

export function RealPortfolioMix({
  balances,
  network,
  price,
}: {
  balances: BotSnapshot["realBalances"];
  network: BotSnapshot["network"];
  price: number | null;
}) {
  const quote = network === "testnet" ? "DBUSDC" : "USDC";
  const cash = balances?.[quote];
  const sui = balances?.SUI;
  const deep = balances?.DEEP;
  if (
    typeof cash !== "number" ||
    typeof sui !== "number" ||
    typeof deep !== "number" ||
    ![cash, sui, deep].every((v) => Number.isFinite(v) && v >= 0)
  ) {
    return (
      <section className="portfolio-mix" aria-label="資産の中身">
        <span className="pm-title">資産の中身</span>
        <p>残高を確認できません</p>
      </section>
    );
  }

  const suiValue = price !== null && price > 0 ? sui * price : NaN;
  const total = cash + suiValue;
  const hasTotal = Number.isFinite(total);
  const cashPercent = total > 0 ? (cash / total) * 100 : 0;
  return (
    <section className="portfolio-mix" aria-label="資産の中身">
      <div className="pm-head">
        <span className="pm-title">資産の中身</span>
        {hasTotal && (
          <span className="pm-total">
            合計（{quote}＋SUI） <b>≈ {total.toFixed(2)} {quote}</b>
          </span>
        )}
      </div>
      {hasTotal && total > 0 && (
        <div className="pm-bar" aria-hidden="true">
          <div className="pm-usdc" style={{ width: `${cashPercent}%` }}>
            {cashPercent > 22 ? quote : ""}
          </div>
          <div className="pm-base" style={{ width: `${100 - cashPercent}%` }}>
            {100 - cashPercent > 14 ? "SUI" : ""}
          </div>
        </div>
      )}
      <div className="pm-rows">
        <div><span className="pm-k">{quote}</span> {quantity.format(cash)}</div>
        <div>
          <span className="pm-k">SUI</span> {quantity.format(sui)}
          {hasTotal && <> <span className="pm-eq">≈ {suiValue.toFixed(2)} {quote}</span></>}
        </div>
        <div><span className="pm-k">DEEP</span> {quantity.format(deep)}</div>
      </div>
      {!hasTotal && <small>SUI の価格を確認できません</small>}
    </section>
  );
}
