import type { ApiFailure } from "./http-errors.ts";

export type Connectivity = "HEALTHY" | "DEGRADED" | "RECOVERING";
export type PaperSafetyState = {
  connectivity: Connectivity;
  resumePending: boolean;
  generation: number;
  episodeAt: number | null;
  lastFailureAt: number | null;
  latestFailure: ApiFailure | null;
  failures: number;
  healthyCycles: number;
  firstHealthyAt: number | null;
  lastHealthyCycleAt: number | null;
  recoveredAt: number | null;
  lastStopReason: string | null;
};
export const paperRecoveryLimits = {
  healthyCycles: 2,
  minimumHealthyMs: 60000,
  minimumCycleSpacingMs: 30000,
  maxEpisodeMs: 180000,
  maxFailures: 9,
};
export const initialPaperSafety = (): PaperSafetyState => ({
  connectivity: "HEALTHY",
  resumePending: false,
  generation: 0,
  episodeAt: null,
  lastFailureAt: null,
  latestFailure: null,
  failures: 0,
  healthyCycles: 0,
  firstHealthyAt: null,
  lastHealthyCycleAt: null,
  recoveredAt: null,
  lastStopReason: null,
});

// A code alone is insufficient: require transport evidence from an approved read API.
export function recoverableReadFailure(
  f: ApiFailure | undefined,
): f is ApiFailure {
  if (!f || !["DeepBook Indexer", "Sui gRPC"].includes(f.api)) return false;
  if (
    f.api === "DeepBook Indexer" &&
    f.host !== "deepbook-indexer.mainnet.mystenlabs.com"
  )
    return false;
  if (f.elapsedMs < 0 || !Number.isFinite(f.occurredAt)) return false;
  if (f.code === "UPSTREAM_DNS_FAILED")
    return (
      f.phase === "DNS" &&
      ["EAI_AGAIN", "ENOTFOUND"].includes(f.causeCode ?? "")
    );
  if (f.code === "UPSTREAM_NETWORK_FAILED")
    return [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "UND_ERR_SOCKET",
      "ERR_HTTP2_SESSION_ERROR",
      "ERR_HTTP2_STREAM_ERROR",
      "ERR_HTTP2_GOAWAY_SESSION",
    ].includes(f.causeCode ?? "");
  if (
    ["UPSTREAM_HTTP_502", "UPSTREAM_HTTP_503", "UPSTREAM_HTTP_504"].includes(
      f.code,
    )
  )
    return f.phase === "HTTP" && f.status === Number(f.code.slice(-3));
  return (
    [
      "UPSTREAM_BODY_TIMEOUT",
      "UPSTREAM_CONNECT_TIMEOUT",
      "UPSTREAM_HEADERS_TIMEOUT",
      "UPSTREAM_TIMEOUT",
    ].includes(f.code) &&
    f.timeoutType === f.phase &&
    f.phase !== "HTTP"
  );
}
