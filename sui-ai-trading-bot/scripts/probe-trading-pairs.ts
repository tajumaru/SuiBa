import { assertNodeVersion } from "./verify-node-version.mjs";
assertNodeVersion({ report: false });
import { DeepBookMarketData } from "../packages/market-data/src/deepbook.ts";
import { deepBookTransport } from "../packages/market-data/src/deepbook-transport.ts";
import { withReadBudget } from "../packages/shared/src/read-budget-node.ts";
import { safeFailure, type TradingPair } from "../packages/shared/src/index.ts";
const evidence = [];
try {
  for (const pair of ["SUI_USDC", "WAL_USDC"] as TradingPair[]) {
    const provider = new DeepBookMarketData(
      () => ({ maxOrder: 5, maxSlippage: 0.003 }),
      undefined,
      true,
      pair,
    );
    const at = Date.now();
    try {
      await withReadBudget(AbortSignal.timeout(45000), true, async () => {
        await provider.prepare();
        const candles = await provider.candles(300);
        await provider.finalize();
        evidence.push({
          pair,
          at,
          completedAt: Date.now(),
          ready: true,
          params: provider.bookParams,
          book: provider.book,
          quality: provider.quality(),
          diagnostics: provider.diagnostics(),
          candles: {
            count: candles.length,
            first: candles[0],
            last: candles.at(-1),
          },
        });
      });
    } catch (error) {
      evidence.push({
        pair,
        at,
        completedAt: Date.now(),
        ready: false,
        error: safeFailure(error),
        params: provider.bookParams,
        book: provider.book,
        quality: provider.quality(),
        diagnostics: provider.diagnostics(),
      });
    }
  }
} finally {
  deepBookTransport.close();
}
console.log(
  JSON.stringify(
    { mode: "READ_ONLY", node: process.version, evidence },
    null,
    2,
  ),
);
