import { mkdirSync, writeFileSync } from "node:fs";
import { compareStrategies } from "../packages/backtest-engine/src/strategy-comparison.ts";
import type { Candle } from "../packages/shared/src/index.ts";
// Deterministic artificial candles. No fabricated book history is supplied.
let seed = 20261020,
  price = 2;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};
const candles: Candle[] = Array.from({ length: 600 }, (_, i) => {
  const open = price;
  price = Math.max(
    0.2,
    price * (1 + 0.0015 + 0.008 * Math.sin(i / 4) + 0.025 * (random() - 0.5)),
  );
  return {
    timestamp: 1790812800 + i * 300,
    timeframe: 300,
    source: "SYNTHETIC:seed=20261020",
    open,
    close: price,
    high: Math.max(open, price) * 1.002,
    low: Math.min(open, price) * 0.998,
    volume: 100000,
  };
});
const result = await compareStrategies(
  candles,
  {
    start: candles[200].timestamp,
    trainEnd: candles[199].timestamp,
    end: candles.at(-1)!.timestamp,
  },
  [],
);
const summarize = (r: typeof result.baseline) => ({
  signals: r.signalCounts,
  summary: r.summary,
  averageNetSellPnl: r.averageNetSellPnl,
  skipReasons: r.skipReasons,
});
const report = {
  source: "SYNTHETIC, NOT MAINNET",
  coverage: result.coverage,
  baseline: summarize(result.baseline),
  candidate: summarize(result.candidate),
  limitations: result.limitations,
};
mkdirSync("docs", { recursive: true });
writeFileSync(
  "docs/book-comparison-synthetic.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.info(JSON.stringify(report, null, 2));
