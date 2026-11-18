export type MarketMode = "geckoterminal" | "deepbook" | "auto";
export type CandleReconstruction = "off" | "verified";

export function resolveMarketConfig(env: NodeJS.ProcessEnv): {
  marketMode: MarketMode;
  reconstruction: CandleReconstruction;
} {
  const marketMode = env.MARKET_DATA_PROVIDER ?? "deepbook";
  if (!(["geckoterminal", "deepbook", "auto"] as string[]).includes(marketMode))
    throw new Error("INVALID_MARKET_DATA_PROVIDER");

  const reconstruction = env.DEEPBOOK_RECONSTRUCT_CANDLES ?? "verified";
  if (!(["off", "verified"] as string[]).includes(reconstruction))
    throw new Error("INVALID_DEEPBOOK_RECONSTRUCTION");

  return {
    marketMode: marketMode as MarketMode,
    reconstruction: reconstruction as CandleReconstruction,
  };
}
