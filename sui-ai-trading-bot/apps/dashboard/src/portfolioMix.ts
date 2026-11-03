/**
 * The portfolio's composition for the "資産の中身" block: how
 * much of the total sits in cash (USDC) and how much in the
 * base asset at the current price. A buy converts one into the
 * other without moving the total; afterwards the base slice
 * breathes with the price. The multiplication and the gain
 * against the acquisition cost are the point — they are what
 * make "the total does not move when the bot buys" readable
 * at a glance.
 */
export interface PortfolioMixModel {
  total: number;
  usdc: number;
  baseQty: number;
  baseValue: number;
  /** Width of the cash segment, 0..100. */
  usdcPct: number;
  basePct: number;
  /** Unrealised gain of the open holding vs its cost basis. */
  gain: number | null;
  costBasis: number;
}

export function portfolioMixModel(input: {
  usdc: number;
  baseQty: number;
  price: number | null;
  costBasis: number;
}): PortfolioMixModel | null {
  const { usdc, baseQty, price, costBasis } = input;
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(usdc) || !Number.isFinite(baseQty)) return null;
  if (usdc < 0 || baseQty < 0) return null;
  const baseValue = baseQty * price;
  const total = usdc + baseValue;
  if (!(total > 0)) return null;
  return {
    total,
    usdc,
    baseQty,
    baseValue,
    usdcPct: (usdc / total) * 100,
    basePct: (baseValue / total) * 100,
    gain: baseQty > 0 ? baseValue - costBasis : null,
    costBasis,
  };
}

/** Prices under 10 keep 4 decimals (SUI/WAL territory). */
export function priceText(price: number): string {
  return price >= 10 ? price.toFixed(2) : price.toFixed(4);
}

export function signedMoney(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(2)}`;
}
