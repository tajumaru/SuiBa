import type { ChainInfo } from "../../../packages/shared/src/index.ts";

/**
 * The Sui chain readout: epoch and TPS, sampled by the worker
 * beside the trading paths purely for display — TPS only moves
 * while samples keep arriving, so a frozen number is itself a
 * visible sign that the chain read has gone quiet. Kept to two
 * numbers on purpose (owner's call, 2026-11-19: the overview
 * carried too much information): the fuller vitals (checkpoint,
 * gas, next epoch, validators) were display-only noise on a
 * phone screen, and the "Built on Sui" credit moved to the
 * version footer. Since 2026-11-20 the readout lives in the
 * Worker status panel's header (owner's call) instead of a
 * standalone strip under the ticker on every tab.
 */
/** Reference gas price as Sui tooling quotes it: raw MIST. */
export function gasPriceText(gasMist: number): string {
  return `${gasMist.toLocaleString("en-US")} MIST`;
}

/** Time until the next epoch, from the chain's own start +
 * duration parameters. Epochs can close slightly off schedule,
 * so the strip labels this 目安. */
export function epochRemainingText(
  epochStartMs: number,
  epochDurationMs: number,
  now: number,
): string {
  const remaining = epochStartMs + epochDurationMs - now;
  if (remaining <= 0) return "まもなく";
  const minutes = Math.floor(remaining / 60000),
    hours = Math.floor(minutes / 60);
  return hours >= 1 ? `あと${hours}時間${minutes % 60}分` : `あと${minutes}分`;
}

export function ChainReadout({ chain }: { chain: ChainInfo | null }) {
  if (!chain) return null;
  return (
    <span className="worker-chain" aria-label="Suiチェーン情報">
      EPOCH <strong>{chain.epoch.toLocaleString("en-US")}</strong>
      {" · "}
      TPS{" "}
      <strong>
        {chain.tps == null ? "—" : chain.tps.toLocaleString("en-US")}
      </strong>
    </span>
  );
}
