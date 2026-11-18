import { describe, expect, test } from "vitest";
import { resolveMarketConfig } from "../apps/worker/src/market-config.ts";

describe("worker market config", () => {
  test("defaults to strict DeepBook with verified candle reconstruction", () => {
    expect(resolveMarketConfig({})).toEqual({
      marketMode: "deepbook",
      reconstruction: "verified",
    });
  });

  test("preserves explicit provider and reconstruction settings", () => {
    expect(
      resolveMarketConfig({
        MARKET_DATA_PROVIDER: "geckoterminal",
        DEEPBOOK_RECONSTRUCT_CANDLES: "off",
      }),
    ).toEqual({ marketMode: "geckoterminal", reconstruction: "off" });
  });
});
