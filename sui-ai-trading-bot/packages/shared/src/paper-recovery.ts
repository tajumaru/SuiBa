import type { ApiFailure } from "./http-errors.ts";

export type Connectivity = "HEALTHY" | "DEGRADED" | "RECOVERING";
export type PaperRecoveryProof = {
  mode: "PAPER";
  healthyCycles: number;
  firstHealthyAt: number;
  lastFailureAt: number;
  confirmedAt: number;
  generation: number;
  marketHealthy: true;
  suiHealthy: true;
  ledgerHealthy: true;
  backoff: false;
};
export type PaperSafetyState = {
  connectivity: Connectivity;
  resumePending: boolean;
  generation: number;
  episodeAt: number | null;
  lastFailureAt: number | null;
  latestFailure: ApiFailure | null;
  failures: number;
  /** Per-episode failure tally keyed "api/code" (market stalls
   * use "MarketData/<reason>"), so a pause or stop can be
   * diagnosed after the fact instead of only from the single
   * latest failure. Belongs to the current episodeAt: a failure
   * arriving while episodeAt is null starts a fresh tally. */
  episodeTally: Record<string, number>;
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
/** A candle-stale episode means the indexer fell behind on candle
 * publication (one missing trailing candle consumes most of the
 * staleness allowance by itself), not that a read failed, so it
 * earns a longer deadline (decided 2026-11-07 after two validation
 * runs hard-stopped on single missing candles). The failure count
 * matches the stall-counting throttle (one counted failure per
 * 30 s), so the time bound is what actually decides. Only an
 * episode whose every counted failure is a candle stale earns
 * these limits; any other failure joining the episode restores
 * the standard limits above.
 *
 * The set of keys earning these limits grew on 2026-11-10
 * (owner's option A): an order-book guard reading (wide spread,
 * thin, stale or malformed book) is the same kind of slow-moving
 * market state, not a broken read — the third 24h validation run
 * died when an episode opened by a single SPREAD_TOO_WIDE reading
 * timed out at 182 s in the thin overnight book (failures=1), so
 * book-guard-only episodes earn the long window too. The name is
 * kept from the original candle-stale decision. */
export const staleEpisodeLimits = {
  maxEpisodeMs: 1800000,
  maxFailures: 61,
};
/** Tally keys whose counted failures describe a slow-moving
 * market state rather than a broken read: candle publication
 * lagging, and the order-book guard readings that
 * bookGuardThrowToEpisode routes into the episode. An episode
 * tallied only with these keys earns staleEpisodeLimits; any
 * other key joining the episode restores the standard limits. */
export const slowMarketTallyKeys: ReadonlySet<string> = new Set([
  "MarketData/CANDLE_STALE",
  "MarketData/SPREAD_TOO_WIDE",
  "MarketData/THIN_ORDERBOOK",
  "MarketData/STALE_ORDERBOOK",
  "MarketData/INVALID_ORDERBOOK",
]);
export function episodeLimits(s: PaperSafetyState) {
  const keys = Object.keys(s.episodeTally);
  return keys.length > 0 && keys.every((key) => slowMarketTallyKeys.has(key))
    ? staleEpisodeLimits
    : paperRecoveryLimits;
}
export const initialPaperSafety = (): PaperSafetyState => ({
  connectivity: "HEALTHY",
  resumePending: false,
  generation: 0,
  episodeAt: null,
  lastFailureAt: null,
  latestFailure: null,
  failures: 0,
  episodeTally: {},
  healthyCycles: 0,
  firstHealthyAt: null,
  lastHealthyCycleAt: null,
  recoveredAt: null,
  lastStopReason: null,
});

/** The closing record of one recovery episode (a pause that
 * ended by recovering, by escalating to a hard stop, or by the
 * process going away). Attached to the closing operation event
 * and included in the AI diagnostic export. */
export interface EpisodeSummary {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  failures: number;
  tally: Record<string, number>;
}
export function episodeSummaryOf(
  s: PaperSafetyState,
  endedAt: number,
): EpisodeSummary | null {
  if (s.episodeAt == null) return null;
  return {
    startedAt: s.episodeAt,
    endedAt,
    durationMs: Math.max(0, endedAt - s.episodeAt),
    failures: s.failures,
    tally: { ...s.episodeTally },
  };
}

// A code alone is insufficient: require transport evidence from an approved read API.
export function recoverableReadFailure(
  f: ApiFailure | undefined,
): f is ApiFailure {
  if (!f || !["DeepBook Indexer", "Sui gRPC", "GeckoTerminal"].includes(f.api))
    return false;
  if (
    f.api === "DeepBook Indexer" &&
    f.host !== "deepbook-indexer.mainnet.mystenlabs.com"
  )
    return false;
  if (f.api === "GeckoTerminal" && f.host !== "api.geckoterminal.com")
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
