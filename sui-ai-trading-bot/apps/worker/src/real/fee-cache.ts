import type { PoolTradeParams } from "@mysten/deepbook-v3";

export const REAL_TAKER_FEE_ASSUMPTION = 0.001;

export type RealFeeEstimate = {
  takerFee: number | null;
  source: "POOL_ACTUAL" | "DESIGN_ASSUMPTION" | "UNAVAILABLE";
  stale: boolean;
  epoch: number | null;
  readAt: number | null;
};

type FeeSnapshot = {
  tradeParams: PoolTradeParams | null;
  accountInfo?: { epoch?: string };
};

type CachedFee = {
  tradeParams: PoolTradeParams;
  epoch: number | null;
  readAt: number;
};

/** REAL-only, epoch-scoped view of the trade parameters already read by the
 * DeepBook snapshot path. SDK 2.8.0 values are normalized and are never scaled
 * again here. */
export class RealFeeCache {
  private current: CachedFee | null = null;
  private lastSuccessful: CachedFee | null = null;

  constructor(private readonly snapshot: () => Promise<FeeSnapshot>) {}

  observe(value: FeeSnapshot, epoch: number | null = snapshotEpoch(value)) {
    if (value.tradeParams === null) return;
    assertTradeParams(value.tradeParams);
    const cached = {
      tradeParams: value.tradeParams,
      epoch,
      readAt: Date.now(),
    };
    this.lastSuccessful = cached;
    this.current = epoch === null ? null : cached;
  }

  async estimate(
    side: "BUY" | "SELL",
    currentEpoch: number | null,
  ): Promise<RealFeeEstimate> {
    if (currentEpoch !== null && this.current?.epoch === currentEpoch)
      return actual(this.current, false);

    try {
      const value = await this.snapshot();
      if (value.tradeParams === null)
        throw Error("REAL_TRADE_PARAMS_UNAVAILABLE");
      assertTradeParams(value.tradeParams);
      const cached = {
        tradeParams: value.tradeParams,
        epoch: currentEpoch,
        readAt: Date.now(),
      };
      this.lastSuccessful = cached;
      // When chain epoch is unavailable, the value is usable for this decision
      // only. It must not become a cache hit in a later cycle.
      this.current = currentEpoch === null ? null : cached;
      return actual(cached, false);
    } catch {
      this.current = null;
      if (side === "BUY")
        return {
          takerFee: null,
          source: "UNAVAILABLE",
          stale: true,
          epoch: currentEpoch,
          readAt: null,
        };
      if (this.lastSuccessful) return actual(this.lastSuccessful, true);
      return {
        takerFee: REAL_TAKER_FEE_ASSUMPTION,
        source: "DESIGN_ASSUMPTION",
        stale: true,
        epoch: currentEpoch,
        readAt: null,
      };
    }
  }
}

const snapshotEpoch = (value: FeeSnapshot) => {
  const epoch = Number(value.accountInfo?.epoch);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : null;
};

const assertTradeParams = (value: PoolTradeParams) => {
  if (
    !Number.isFinite(value.takerFee) ||
    value.takerFee < 0 ||
    !Number.isFinite(value.makerFee) ||
    value.makerFee < 0 ||
    !Number.isFinite(value.stakeRequired) ||
    value.stakeRequired < 0
  )
    throw Error("REAL_TRADE_PARAMS_INVALID");
};

const actual = (cached: CachedFee, stale: boolean): RealFeeEstimate => ({
  takerFee: cached.tradeParams.takerFee,
  source: "POOL_ACTUAL",
  stale,
  epoch: cached.epoch,
  readAt: cached.readAt,
});
