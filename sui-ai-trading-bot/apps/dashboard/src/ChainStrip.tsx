import type { ChainInfo } from "../../../packages/shared/src/index.ts";

/**
 * The Sui chain strip: the chain's own vital signs (epoch,
 * latest checkpoint, TPS) in one slim terminal line under the
 * price ticker, on every tab. Sampled by the worker beside the
 * trading paths purely for display — checkpoints advance every
 * couple of seconds, so a frozen number is itself a visible
 * sign that the chain read has gone quiet. Renders nothing
 * until the first sample exists (fail-closed, like the ticker).
 */
/** Reference gas price as Sui tooling quotes it: raw MIST. */
export function gasPriceText(gasMist: number): string {
  return `${gasMist.toLocaleString("en-US")} MIST`;
}

export function ChainStrip({ chain }: { chain: ChainInfo | null }) {
  if (!chain) return null;
  return (
    <div className="chain-strip" aria-label="Suiチェーン情報">
      <span className="chain-strip-label">SUI CHAIN</span>
      <span>
        EPOCH <strong>{chain.epoch.toLocaleString("en-US")}</strong>
      </span>
      <span>
        CHECKPOINT{" "}
        <strong>{chain.checkpoint.toLocaleString("en-US")}</strong>
      </span>
      <span>
        TPS <strong>{chain.tps == null ? "—" : chain.tps.toLocaleString("en-US")}</strong>
      </span>
      {chain.gasMist != null && (
        <span>
          GAS <strong>{gasPriceText(chain.gasMist)}</strong>
        </span>
      )}
    </div>
  );
}
