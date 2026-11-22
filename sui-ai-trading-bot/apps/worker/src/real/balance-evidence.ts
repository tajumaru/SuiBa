import type { RealBalanceBaseline } from "./database.ts";

// Coin decimals used for Phase 1 ledger comparisons: SUI has 9; DBUSDC and
// DEEP have 6. DeepBook's internal DEEP scalar (1e9) is not the coin scalar.
export const PHASE1_DECIMALS = { SUI: 9, DBUSDC: 6, DEEP: 6 } as const;
export type Asset = keyof typeof PHASE1_DECIMALS;
export const atomic = (value: number | string, decimals: number) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0)
      throw Error("REAL_BALANCE_INVALID");
    const scaled = value * 10 ** decimals;
    const rounded = Math.round(scaled);
    if (
      !Number.isSafeInteger(rounded) ||
      Math.abs(scaled - rounded) >
        Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8
    )
      throw Error("REAL_BALANCE_PRECISION_INVALID");
    return BigInt(rounded);
  }
  const text = value;
  if (!/^\d+(\.\d+)?$/.test(text)) throw Error("REAL_BALANCE_INVALID");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw Error("REAL_BALANCE_PRECISION_INVALID");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"))
  );
};

export function balanceEvidence(
  rows: Array<Record<string, string>>,
  snapshot: {
    balances: Record<Asset, unknown>;
    locked: Partial<Record<Asset, unknown>>;
    settledUnclaimed: Partial<Record<Asset, unknown>>;
    owedBalances?: Partial<Record<Asset, unknown>>;
    botGasSuiMist: string;
    decimals?: Partial<Record<Asset, number>>;
  },
  baseline?: RealBalanceBaseline,
  appliedTradeFeeCount = 0,
) {
  const differences: Record<string, string> = {};
  let validDecimals = true;
  for (const asset of Object.keys(PHASE1_DECIMALS) as Asset[]) {
    if (
      snapshot.decimals?.[asset] !== undefined &&
      snapshot.decimals[asset] !== PHASE1_DECIMALS[asset]
    )
      validDecimals = false;
    const row = rows.find((candidate) => candidate.asset === asset) ?? {};
    const offset = baseline?.ledgerOffsets?.[asset];
    const delta = (value: string | undefined, start: string | undefined) =>
      BigInt(value ?? "0") - BigInt(start ?? "0");
    const expected = {
      available:
        BigInt(baseline?.assets[asset].availableAtomic ?? "0") +
        delta(row.availableAtomic, offset?.availableAtomic),
      locked:
        BigInt(baseline?.assets[asset].lockedAtomic ?? "0") +
        delta(row.orderLockedAtomic, offset?.lockedAtomic),
      settled:
        BigInt(baseline?.assets[asset].settledUnclaimedAtomic ?? "0") +
        delta(row.settledUnclaimedAtomic, offset?.settledUnclaimedAtomic),
      owed: BigInt(baseline?.assets[asset].owedAtomic ?? "0"),
      fee: baseline ? delta(row.feeAtomic, offset?.feeAtomic) : 0n,
      gas:
        asset !== "SUI"
          ? 0n
          : baseline
            ? BigInt(baseline.botGasSuiMist) -
              delta(row.gasMist, offset?.gasMist)
            : BigInt(row.gasMist ?? "0"),
    };
    const actual = {
      available: atomic(
        snapshot.balances[asset] as number | string,
        PHASE1_DECIMALS[asset],
      ),
      locked: atomic(
        (snapshot.locked[asset] ?? 0) as number | string,
        PHASE1_DECIMALS[asset],
      ),
      settled: atomic(
        (snapshot.settledUnclaimed[asset] ?? 0) as number | string,
        PHASE1_DECIMALS[asset],
      ),
      owed: atomic(
        (snapshot.owedBalances?.[asset] ?? 0) as number | string,
        PHASE1_DECIMALS[asset],
      ),
      // Fees are already represented in the available balance event deltas;
      // this metadata component must therefore agree with that same ledger.
      fee: delta(row.feeAtomic, offset?.feeAtomic),
      gas: asset === "SUI" ? BigInt(snapshot.botGasSuiMist) : 0n,
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>)
      differences[`${asset}.${key}`] = (actual[key] - expected[key]).toString();
  }
  return {
    explained:
      validDecimals &&
      Object.entries(differences).every(
        ([component, value]) =>
          value === "0" ||
          (component === "DEEP.available" &&
            BigInt(value) >= -BigInt(appliedTradeFeeCount) &&
            BigInt(value) <= 0n),
      ),
    validDecimals,
    differences,
  };
}
