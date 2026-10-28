import { assertNodeVersion } from "./verify-node-version.mjs";
import { DeepBookMarketData } from "../packages/market-data/src/deepbook.ts";
import { deepBookTransport } from "../packages/market-data/src/deepbook-transport.ts";
import { withReadBudget } from "../packages/shared/src/read-budget-node.ts";
import {
  defaults,
  safeFailure,
  type TradingPair,
} from "../packages/shared/src/index.ts";
assertNodeVersion({ report: false });
const samples = [];
try {
  for (let round = 0; round < 3; round++)
    for (const pair of ["WAL_USDC", "SUI_USDC"] as TradingPair[]) {
      const provider = new DeepBookMarketData(
        () => defaults,
        undefined,
        true,
        pair,
      );
      const beganAt = Date.now();
      let error: string | null = null;
      try {
        await withReadBudget(AbortSignal.timeout(30000), true, () =>
          provider.prepare(),
        );
      } catch (e) {
        error = safeFailure(e);
      }
      samples.push({
        pair,
        round,
        beganAt,
        completedAt: Date.now(),
        ready: error === null,
        error,
        diagnostics: provider.diagnostics(),
      });
    }
} finally {
  deepBookTransport.close();
}
console.log(
  JSON.stringify(
    {
      mode: "READ_ONLY",
      node: process.version,
      maxOrder: defaults.maxOrder,
      maxSpread: defaults.maxSlippage,
      samples,
    },
    null,
    2,
  ),
);
