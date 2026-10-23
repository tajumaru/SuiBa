export type RequestPhase =
  "HEADERS_OR_CONNECT" | "CONNECT" | "DNS" | "TLS" | "BODY" | "HTTP";
export type ApiFailure = {
  api: string;
  url: string;
  host: string;
  operation: string;
  method: string;
  code: string;
  causeCode: string | null;
  phase: RequestPhase;
  status: number | null;
  elapsedMs: number;
  occurredAt: number;
  startedAt?: number;
  endedAt?: number;
  retryCount?: number;
  lastSuccessAt?: number | null;
  lastApiSuccessAt?: number | null;
  timeoutType?: RequestPhase | null;
  timeframe?: string | null;
  transportTimings?: Record<string, number | boolean>;
};
const knownCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_ERROR",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_HANDSHAKE_TIMEOUT",
]);
function errorCodes(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 3) return [];
  const e = value as { code?: unknown; cause?: unknown; errors?: unknown[] };
  return [
    typeof e.code === "string" && knownCodes.has(e.code) ? e.code : null,
    ...errorCodes(e.cause, depth + 1),
    ...(Array.isArray(e.errors)
      ? e.errors.slice(0, 8).flatMap((x) => errorCodes(x, depth + 1))
      : []),
  ].filter((x): x is string => x !== null);
}
export function classifyHttpFailure(
  error: unknown,
  phase: RequestPhase,
  signal?: AbortSignal,
) {
  const name =
    error && typeof error === "object" && "name" in error ? error.name : null;
  const codes = errorCodes(error);
  const causeCode = codes[0] ?? null;
  if (signal?.aborted || name === "AbortError" || name === "TimeoutError") {
    const timedOut =
      signal?.reason?.name === "TimeoutError" || name === "TimeoutError";
    return {
      code: timedOut
        ? phase === "BODY"
          ? "UPSTREAM_BODY_TIMEOUT"
          : phase === "CONNECT"
            ? "UPSTREAM_CONNECT_TIMEOUT"
            : "UPSTREAM_TIMEOUT"
        : "API_CANCELLED",
      phase,
      causeCode,
    };
  }
  if (codes.some((c) => c === "ENOTFOUND" || c === "EAI_AGAIN"))
    return { code: "UPSTREAM_DNS_FAILED", phase: "DNS" as const, causeCode };
  if (codes.includes("UND_ERR_CONNECT_TIMEOUT"))
    return {
      code: "UPSTREAM_CONNECT_TIMEOUT",
      phase: "CONNECT" as const,
      causeCode,
    };
  if (codes.includes("UND_ERR_HEADERS_TIMEOUT"))
    return { code: "UPSTREAM_HEADERS_TIMEOUT", phase, causeCode };
  if (codes.includes("UND_ERR_BODY_TIMEOUT"))
    return { code: "UPSTREAM_BODY_TIMEOUT", phase: "BODY" as const, causeCode };
  if (codes.some((c) => /CERT|TLS|SELF_SIGNED|LEAF_SIGNATURE/.test(c)))
    return { code: "UPSTREAM_TLS_FAILED", phase: "TLS" as const, causeCode };
  return { code: "UPSTREAM_NETWORK_FAILED", phase, causeCode };
}
export function requestIdentity(api: string, value: string, method: string) {
  const url = new URL(value);
  let operation =
    api === "Sui gRPC"
      ? "SUI_GRPC_READ"
      : api === "Cetus"
        ? "CETUS_HTTP_READ"
        : "HTTP_READ";
  let safeUrl = `${url.origin}/[redacted]`;
  let timeframe: string | null = null;
  if (url.hostname === "deepbook-indexer.mainnet.mystenlabs.com") {
    if (url.pathname === "/ohclv/SUI_USDC") {
      operation = "OHLCV_FETCH";
      const interval = url.searchParams.get("interval");
      timeframe = ["1m", "5m", "15m", "1h", "4h", "1d"].includes(interval ?? "")
        ? interval
        : null;
    } else if (url.pathname === "/orderbook/SUI_USDC")
      operation = "ORDERBOOK_FETCH";
    else if (url.pathname === "/status") operation = "MARKET_STATUS";
    else if (url.pathname === "/get_pools") operation = "PROVIDER_HEALTH";
    else if (url.pathname === "/trades/SUI_USDC")
      operation = "TRADE_EVIDENCE_FETCH";
  }
  const publicGeckoPath =
    /^\/api\/v2\/networks\/sui-network\/(?:pools\/0x[a-f0-9]{64}(?:\/ohlcv\/(?:minute|hour))?|tokens\/0x2%3A%3Asui%3A%3ASUI\/pools)$/i;
  if (
    url.hostname === "api.geckoterminal.com" &&
    publicGeckoPath.test(url.pathname)
  ) {
    operation = url.pathname.includes("/ohlcv/hour")
      ? "OHLCV_1H"
      : url.pathname.includes("/ohlcv/minute")
        ? url.searchParams.get("aggregate") === "15"
          ? "OHLCV_15M"
          : "OHLCV_5M"
        : url.pathname.includes("/tokens/")
          ? "POOL_DISCOVERY"
          : "POOL_METADATA";
    const allowed: Record<string, string[]> = {
      include: ["base_token,quote_token"],
      aggregate: ["1", "5", "15"],
      limit: ["1000"],
      currency: ["token"],
      token: ["base", "quote"],
      include_empty_intervals: ["false"],
    };
    const query = new URLSearchParams();
    for (const [key, values] of Object.entries(allowed)) {
      const v = url.searchParams.get(key);
      if (v !== null && values.includes(v)) query.set(key, v);
    }
    safeUrl = `${url.origin}${url.pathname}${query.size ? "?" + query.toString() : ""}`;
  }
  return {
    api,
    url: safeUrl,
    host: url.host,
    operation,
    ...(timeframe ? { timeframe } : {}),
    method: ["GET", "POST", "HEAD"].includes(method) ? method : "OTHER",
  };
}
export class HttpStatusFailure extends Error {
  constructor(readonly status: number) {
    super("UPSTREAM_HTTP_" + status);
  }
}

// Only fixed phase names and numeric timings may cross the logging boundary.
export function transportDiagnostics(error: unknown): {
  phase?: RequestPhase;
  status?: number;
  timings?: Record<string, number | boolean>;
} {
  if (!error || typeof error !== "object") return {};
  const e = error as {
    requestPhase?: unknown;
    responseStatus?: unknown;
    transportTimings?: Record<string, unknown>;
  };
  const phases: RequestPhase[] = [
    "DNS",
    "CONNECT",
    "TLS",
    "HEADERS_OR_CONNECT",
    "BODY",
    "HTTP",
  ];
  const phase = phases.includes(e.requestPhase as RequestPhase)
    ? (e.requestPhase as RequestPhase)
    : undefined;
  const timings: Record<string, number | boolean> = {};
  for (const key of ["dnsMs", "tcpMs", "tlsMs", "headersMs", "totalMs"]) {
    const v = e.transportTimings?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) timings[key] = v;
  }
  if (typeof e.transportTimings?.reusedConnection === "boolean")
    timings.reusedConnection = e.transportTimings.reusedConnection;
  const status =
    typeof e.responseStatus === "number" &&
    Number.isInteger(e.responseStatus) &&
    e.responseStatus >= 100 &&
    e.responseStatus <= 599
      ? e.responseStatus
      : undefined;
  return {
    phase,
    ...(status !== undefined ? { status } : {}),
    timings: Object.keys(timings).length ? timings : undefined,
  };
}
