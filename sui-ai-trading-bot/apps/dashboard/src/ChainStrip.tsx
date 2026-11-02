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
      {chain.epochStartMs != null && chain.epochDurationMs != null && (
        <span>
          NEXT EPOCH{" "}
          <strong>
            {epochRemainingText(
              chain.epochStartMs,
              chain.epochDurationMs,
              Date.now(),
            )}
          </strong>
          （目安）
        </span>
      )}
      {chain.validators != null && (
        <span>
          VALIDATORS <strong>{chain.validators.toLocaleString("en-US")}</strong>
        </span>
      )}
    </div>
  );
}
