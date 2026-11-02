/**
 * Resolves the Sui gRPC endpoint ring for the worker's read
 * clients (the trading client's health/balance reads and the
 * display-only chain sampler share the same list, through
 * their own separate clients).
 *
 * Primary: SUI_GRPC_URL, or the public fullnode by default.
 * Fallbacks: SUI_GRPC_FALLBACK_URLS (comma-separated) when set
 * — an empty value disables failover — otherwise the verified
 * keyless public fallback below. The fallback was probed live
 * on 2026-11-03 for every method these clients call (coin
 * metadata for SUI and USDC, balance, service info, checkpoint
 * summary, reference gas price, system state, epoch
 * validators); the other large providers (Ankr, Chainstack,
 * BlockPI) all require an API key, so they can only join the
 * ring through the env override.
 */
export const DEFAULT_SUI_GRPC_FALLBACK_URLS = [
  "https://mainnet.sui.rpcpool.com",
];

export function resolveSuiGrpcEndpoints(
  env: NodeJS.ProcessEnv = process.env,
): { primary: string | undefined; fallbacks: string[] } {
  const primary = env.SUI_GRPC_URL || undefined;
  const raw = env.SUI_GRPC_FALLBACK_URLS;
  const fallbacks =
    raw === undefined
      ? [...DEFAULT_SUI_GRPC_FALLBACK_URLS]
      : raw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  return { primary, fallbacks };
}
