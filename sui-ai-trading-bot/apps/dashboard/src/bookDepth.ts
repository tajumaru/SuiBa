import type { BookLevels } from "../../../packages/shared/src/index.ts";

function accumulate(levels: BookLevels["bids"], direction: -1 | 1) {
  const steps: { price: number; total: number }[] = [];
  let total = 0;
  for (const [price, quantity] of levels) {
    const previous = steps.at(-1);
    if (
      !Number.isFinite(price) ||
      price <= 0 ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      (previous && (price - previous.price) * direction < 0)
    ) {
      return null;
    }
    total += quantity;
    if (!Number.isFinite(total)) return null;
    if (previous?.price === price) previous.total = total;
    else steps.push({ price, total });
  }
  return steps.length ? { steps, total } : null;
}

export function bookDepthModel(levels: BookLevels | null) {
  if (!levels) return null;
  const bids = accumulate(levels.bids, -1);
  const asks = accumulate(levels.asks, 1);
  if (!bids || !asks) return null;

  const bestBid = bids.steps[0]!.price;
  const bestAsk = asks.steps[0]!.price;
  if (bestBid > bestAsk) return null;
  const mid = bestBid + (bestAsk - bestBid) / 2;
  const radius = Math.max(
    mid - bids.steps.at(-1)!.price,
    asks.steps.at(-1)!.price - mid,
  );
  const maxTotal = Math.max(bids.total, asks.total);
  const x = (price: number) =>
    radius === 0 ? 50 : 50 + ((price - mid) / radius) * 45;
  const y = (total: number) => 100 - (total / maxTotal) * 100;

  function curve(
    { steps, total }: NonNullable<ReturnType<typeof accumulate>>,
    edge: number,
  ) {
    const start = x(steps[0]!.price);
    const path =
      `M ${start} 100` +
      steps.map((step) => ` H ${x(step.price)} V ${y(step.total)}`).join("") +
      ` H ${edge}`;
    return { total, path, area: `${path} V 100 Z` };
  }

  return {
    bestBid,
    bestAsk,
    maxTotal,
    bids: curve(bids, 0),
    asks: curve(asks, 100),
  };
}
