import { ReadOnlySuiClient } from "../../../packages/sui-client/src/index.ts";
import { GeckoMarketData } from "../../../packages/market-data/src/index.ts";
import { CetusRouter } from "../../../packages/dex-router/src/index.ts";
import { SUI, USDC } from "../../../packages/shared/src/index.ts";
try {
  const sui = new ReadOnlySuiClient();
  console.info("gRPC", await sui.health());
  const market = new GeckoMarketData();
  console.info("pool", await market.discover());
  const c = await market.candles(300);
  console.info("5m candles", c.length);
  for (const [from, to, amountIn] of [
    [USDC, SUI, "5000000"],
    [SUI, USDC, "1000000000"],
  ]) {
    const router = new CetusRouter();
    const q = await router.getQuote({
      from,
      to,
      amountIn,
      slippage: 0.003,
      referencePrice: c.at(-1)!.close,
    });
    console.info("quote", {
      from,
      to,
      amountOut: q.amountOut,
      priceImpact: q.priceImpact,
      valid: await router.validateQuote(q),
    });
  }
} catch {
  console.error(
    "Read-only mainnet smoke failed; no transaction was constructed or sent.",
  );
  process.exitCode = 1;
}
