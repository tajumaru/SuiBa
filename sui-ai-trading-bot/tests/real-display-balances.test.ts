import { expect, it, vi } from "vitest";
import { buildSnapshot, type SnapshotSources } from "../apps/worker/src/engine-snapshot.ts";
import { cacheRealBalances } from "../apps/worker/src/real/display-balances.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { BotDatabase } from "../packages/database/src/index.ts";

const parts = {
  balances: { SUI: 1, DBUSDC: 2, DEEP: 3 },
  locked: { SUI: 4, DBUSDC: 5, DEEP: 6 },
  settledUnclaimed: { SUI: 7, DBUSDC: 8, DEEP: 9 },
};

it("adds the three kinds of balance, spaces attempts by 60 seconds, keeps the last value while refreshing and omits failures", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  const read = vi.fn().mockResolvedValueOnce(parts).mockRejectedValueOnce(Error("offline"))
    .mockResolvedValueOnce(parts);
  const current = cacheRealBalances(read);
  try {
    expect(current()).toBeUndefined();
    expect(current()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    clock.mockReturnValue(59_999);
    expect(current()).toEqual({ SUI: 12, DBUSDC: 15, DEEP: 18 });
    expect(read).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(60_000);
    // While the second read is in flight the last good value stays.
    expect(current()).toEqual({ SUI: 12, DBUSDC: 15, DEEP: 18 });
    await Promise.resolve();
    // The read failed, so the value is omitted rather than stale.
    expect(current()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(120_000);
    expect(current()).toBeUndefined();
    await Promise.resolve();
    expect(current()).toEqual({ SUI: 12, DBUSDC: 15, DEEP: 18 });
    expect(read).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
  }
});

it("includes the network and exposes cached balances only in REAL snapshots", () => {
  const db = new BotDatabase(":memory:");
  try {
    const market = { candles: async () => [] };
    const healthy = { healthy: true, checkedAt: 0, failures: 0 };
    const sui = { health: async () => healthy, status: healthy };
    const engine = new BotEngine(db, market, {
      getQuote: async () => { throw Error("offline test"); },
      validateQuote: async () => false,
    }, sui);
    const realBalances = vi.fn(() => parts.balances);
    const realReconciliation = vi.fn(() => ({ nonTerminalSubmissions: 2 }));
    const sources: SnapshotSources = {
      mode: "PAPER", network: "mainnet", pair: "SUI_USDC",
      db, monitor: engine.monitor, market, sui, realBalances, realReconciliation,
      chainInfo: () => null, btcInfo: () => null, bookImbalance: () => null,
      bookLevels: () => null, longTermDaily: () => null,
    };
    const paper = buildSnapshot(sources);
    expect(paper).toMatchObject({ mode: "PAPER", network: "mainnet" });
    expect(paper).not.toHaveProperty("realBalances");
    expect(paper).not.toHaveProperty("realReconciliation");
    expect(realReconciliation).not.toHaveBeenCalled();
    expect(realBalances).not.toHaveBeenCalled();
    const real = { ...sources, mode: "REAL", network: "testnet" } as const;
    expect(buildSnapshot(real, { light: true })).toMatchObject({
      mode: "REAL", network: "testnet", realBalances: parts.balances,
      realReconciliation: { nonTerminalSubmissions: 2 },
    });
    expect(buildSnapshot({ ...real, realBalances: () => undefined }))
      .not.toHaveProperty("realBalances");
  } finally {
    db.close();
  }
});
