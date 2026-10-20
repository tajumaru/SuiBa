import type { Portfolio } from "../../shared/src/index.ts";
export const equity = (p: Portfolio, price: number) => p.usdc + p.sui * price;
export function metrics(values: number[], profits: number[]) {
  let peak = values[0] ?? 0,
    maxDrawdown = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - v) / peak);
  }
  const wins = profits.filter((x) => x > 0),
    losses = profits.filter((x) => x < 0);
  const loss = -losses.reduce((a, b) => a + b, 0);
  return {
    maxDrawdown,
    winRate: profits.length ? wins.length / profits.length : 0,
    profitFactor: loss ? wins.reduce((a, b) => a + b, 0) / loss : null,
  };
}
