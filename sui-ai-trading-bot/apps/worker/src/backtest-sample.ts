import { mkdirSync, writeFileSync } from "node:fs";
import { compareBacktests } from "../../../packages/backtest-engine/src/index.ts";
import { defaults, type Candle } from "../../../packages/shared/src/index.ts";

// Reproducible artificial OHLCV, never presented as Mainnet observations.
export function sampleCandles(): Candle[] {
  let seed = 20261020,
    price = 2;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: 600 }, (_, i) => {
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
}
const c = sampleCandles();
const result = await compareBacktests(
  c,
  {
    start: c[200].timestamp,
    trainEnd: c[199].timestamp,
    end: c.at(-1)!.timestamp,
  },
  defaults,
);
mkdirSync("data/backtests", { recursive: true });
writeFileSync("data/backtests/sample-v2.json", JSON.stringify(result, null, 2));
console.info(
  JSON.stringify(
    {
      source: result.dataset.source,
      off: result.off.summary,
      on: result.on.summary,
      report: "data/backtests/sample-v2.json",
    },
    null,
    2,
  ),
);
