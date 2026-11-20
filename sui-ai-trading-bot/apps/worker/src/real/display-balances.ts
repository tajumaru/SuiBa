import type { createDeepBookReadOnly } from "./read-only.ts";

type ReadBalances = ReturnType<typeof createDeepBookReadOnly>["readBalances"];
export type RealBalances = { SUI: number; DBUSDC?: number; USDC?: number; DEEP: number };

const refreshIntervalMs = 60_000;

// The display never waits for the chain. Polls share one in-flight refresh.
export function cacheRealBalances(read: ReadBalances) {
  let value: RealBalances | undefined;
  let lastAttempt = -Infinity;
  let pending = false;

  const refresh = async () => {
    try {
      const { balances, locked, settledUnclaimed } = await read();
      const total = (asset: keyof typeof balances) =>
        balances[asset] + locked[asset] + settledUnclaimed[asset];
      const next = { SUI: total("SUI"), DBUSDC: total("DBUSDC"), DEEP: total("DEEP") };
      value = Object.values(next).every((v) => Number.isFinite(v) && v >= 0)
        ? next
        : undefined;
    } catch {
      value = undefined;
    } finally {
      pending = false;
    }
  };

  return () => {
    const now = performance.now();
    if (!pending && now - lastAttempt >= refreshIntervalMs) {
      lastAttempt = now;
      pending = true;
      value = undefined;
      void refresh();
    }
    return value;
  };
}
