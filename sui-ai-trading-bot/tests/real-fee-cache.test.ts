import { describe, expect, it, vi } from "vitest";
import {
  REAL_TAKER_FEE_ASSUMPTION,
  RealFeeCache,
} from "../apps/worker/src/real/fee-cache.ts";
import { realCosts } from "../packages/profit-guard/src/index.ts";
import { USDC } from "../packages/shared/src/index.ts";

const params = (takerFee: number) => ({
  takerFee,
  makerFee: takerFee / 2,
  stakeRequired: 100,
});

const quote = {
  from: USDC,
  to: "0xSUI",
  amountIn: "5000000",
  amountOut: "2500000000",
  minAmountOut: "2490000000",
} as never;

describe("REAL ProfitGuard fee cache", () => {
  it("uses the normalized SDK taker rate without dividing it again", () => {
    expect(realCosts(quote, 0.001, 0.03).additionalFeeUsdc).toBe("0.005000");
  });

  it("reuses a successful read only within its epoch and refreshes at a boundary", async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ tradeParams: params(0.001) })
      .mockResolvedValueOnce({ tradeParams: params(0.0008) });
    const cache = new RealFeeCache(snapshot);
    expect((await cache.estimate("BUY", 10)).takerFee).toBe(0.001);
    expect((await cache.estimate("BUY", 10)).takerFee).toBe(0.001);
    expect((await cache.estimate("BUY", 11)).takerFee).toBe(0.0008);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("does not retain a cache hit across cycles when epoch is unavailable", async () => {
    const snapshot = vi.fn().mockResolvedValue({ tradeParams: params(0.001) });
    const cache = new RealFeeCache(snapshot);
    await cache.estimate("BUY", null);
    await cache.estimate("BUY", null);
    expect(snapshot).toHaveBeenCalledTimes(2);
  });

  it("fails BUY closed but permits SELL with the last actual value and a stale flag", async () => {
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce({ tradeParams: params(0.0007) })
      .mockRejectedValue(new Error("read failed"));
    const cache = new RealFeeCache(snapshot);
    await cache.estimate("BUY", 10);
    expect(await cache.estimate("BUY", 11)).toMatchObject({
      takerFee: null,
      source: "UNAVAILABLE",
      stale: true,
    });
    expect(await cache.estimate("SELL", 11)).toMatchObject({
      takerFee: 0.0007,
      source: "POOL_ACTUAL",
      stale: true,
    });
  });

  it("permits the first SELL with the delegated 10 bps assumption and a stale flag", async () => {
    const cache = new RealFeeCache(async () => ({ tradeParams: null }));
    expect(await cache.estimate("BUY", 10)).toMatchObject({
      takerFee: null,
      source: "UNAVAILABLE",
      stale: true,
    });
    expect(await cache.estimate("SELL", 10)).toMatchObject({
      takerFee: REAL_TAKER_FEE_ASSUMPTION,
      source: "DESIGN_ASSUMPTION",
      stale: true,
    });
  });
});
