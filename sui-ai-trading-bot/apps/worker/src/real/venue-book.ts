import { Decimal } from "../../../../packages/shared/src/index.ts";

export type VenueBook = {
  bid_prices: number[];
  bid_quantities: number[];
  ask_prices: number[];
  ask_quantities: number[];
};

type Side = "BUY" | "SELL";

function levelsFor(side: Side, book: VenueBook) {
  return side === "BUY"
    ? [book.ask_prices, book.ask_quantities] as const
    : [book.bid_prices, book.bid_quantities] as const;
}

function hasLevels(side: Side, book: VenueBook) {
  const [prices, quantities] = levelsFor(side, book);
  return prices.length > 0 &&
    prices.length === quantities.length &&
    prices.every((price) => Number.isFinite(price) && price > 0) &&
    quantities.every((quantity) => Number.isFinite(quantity) && quantity > 0);
}

/** All quantities, including the lot and minimum, are in SUI. */
export function capVenueQuantity(
  side: Side,
  desired: Decimal,
  book: VenueBook,
  cap: Decimal,
  lotSize: Decimal,
  minSize: Decimal,
): Decimal | null {
  const [prices, quantities] = levelsFor(side, book);
  const levels = prices.map((price, index) => ({
    price: new Decimal(String(price)),
    quantity: new Decimal(String(quantities[index])),
  }));
  levels.sort((a, b) =>
    side === "BUY" ? a.price.cmp(b.price) : b.price.cmp(a.price),
  );

  let filled = new Decimal(0);
  let remainingBudget = cap;
  for (const level of levels) {
    const quantity = Decimal.min(desired.minus(filled), level.quantity);
    const notional = quantity.mul(level.price);
    if (notional.gt(remainingBudget)) {
      // Count whole lots across all levels, including any partial lot already filled.
      filled = remainingBudget.plus(filled.mul(level.price))
        .dividedToIntegerBy(level.price.mul(lotSize))
        .mul(lotSize);
      break;
    }
    filled = filled.plus(quantity);
    if (filled.eq(desired)) break;
    remainingBudget = remainingBudget.minus(notional);
  }

  const quantity = filled.eq(desired)
    ? filled
    : filled.dividedToIntegerBy(lotSize).mul(lotSize);
  return quantity.gte(minSize) ? quantity : null;
}

/** Reuse a successful read in a known epoch and fall back on refresh failure. */
export class RealVenueBookCache {
  private lastSuccessful: { epoch: number | null; book: VenueBook } | null = null;

  constructor(private readonly read: () => Promise<VenueBook>) {}

  async get(epoch: number | null, side: Side): Promise<VenueBook | null> {
    if (epoch !== null && this.lastSuccessful?.epoch === epoch) {
      const { book } = this.lastSuccessful;
      return hasLevels(side, book) ? book : null;
    }

    try {
      const book = await this.read();
      if (hasLevels("BUY", book) || hasLevels("SELL", book)) {
        this.lastSuccessful = { epoch, book };
        return hasLevels(side, book) ? book : null;
      }
    } catch {
      // Use the last successful read when the refresh throws.
    }
    const book = this.lastSuccessful?.book;
    return book && hasLevels(side, book) ? book : null;
  }
}
