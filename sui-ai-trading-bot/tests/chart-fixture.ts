import type { Candle } from "../packages/shared/src/index.ts";
export const chartFixture = (): Candle[] =>
  Array.from({ length: 1000 }, (_, i) => ({
    timestamp: Date.UTC(2026, 9, 20, 0) / 1000 + i * 300,
    timeframe: 300,
    open: 2 + i * 0.001,
    high: 2.01 + i * 0.001,
    low: 1.99 + i * 0.001,
    close: 2.005 + i * 0.001,
    volume: i,
    source: "DeepBook:SUI_USDC:USDC",
  }));
