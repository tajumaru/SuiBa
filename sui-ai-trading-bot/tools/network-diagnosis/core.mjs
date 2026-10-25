import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

export const LIMITS = Object.freeze({
  durationMs: 1800000,
  intervalMs: 60000,
  spacingMs: 5000,
  cycleMs: 45000,
  suiMs: 10000,
  deepbookMs: 8000,
  maxBodyBytes: 4 * 1024 * 1024,
  maxFailedCycles: 3,
  noSuccessMs: 300000,
  maxAttempts: 90,
});
export const SUI = "https://fullnode.mainnet.sui.io";
export const DEEP = "https://deepbook-indexer.mainnet.mystenlabs.com";
export const COIN = "0x2::sui::SUI";
export const RPC_PATH = "/sui.rpc.v2.StateService/GetCoinInfo";
export const BOOK_PATH = "/orderbook/SUI_USDC?level=2&depth=10";
export const PROFILES = Object.freeze([
  { target: "sui", protocol: "default-fetch", family: 0 },
  ...[0, 4, 6].flatMap((family) => [
    { target: "sui", protocol: "fetch", family },
    { target: "sui", protocol: "h2", family },
    { target: "deepbook", protocol: "h2", family },
  ]),
]);
export const plan = () => ({
  schema: 1,
  limits: LIMITS,
  profiles: PROFILES,
  operations: ["SUI metadata GetCoinInfo (gRPC-Web)", "SUI_USDC orderbook GET"],
  durationMinutes: 30,
  networkRequests: 0,
  maxRequestsPerSide: LIMITS.maxAttempts,
  maxCombinedRequests: LIMITS.maxAttempts * 2,
  qualityVerdict: "NOT_EVALUATED",
  note: "No trading, Bot imports, DB, retries, dotenv or listener. Actual reuse is measured, never assumed.",
});
export function assertNode(version = process.version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m || +m[1] !== 24 || +m[2] < 22 || (+m[2] === 22 && +m[3] < 1))
    throw Error("NODE_VERSION_UNSUPPORTED");
}
export function authorize(args, env = process.env) {
  if (!args.executeLive) return false;
  if (env.CI && env.CI !== "false")
    throw Error("LIVE_DIAGNOSIS_FORBIDDEN_IN_CI");
  if (
    !["windows", "docker"].includes(args.side) ||
    !/^netdiag-[a-z0-9-]+$/.test(args.runId ?? "")
  )
    throw Error("INVALID_RUN_IDENTITY");
  assertNode();
  return true;
}
export function argsOf(argv) {
  const result = {};
  const keys = {
    "--side": "side",
    "--out": "out",
    "--run-id": "runId",
    "--start-at": "startAt",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--execute-live") result.executeLive = true;
    else if (keys[key] && argv[i + 1] && !argv[i + 1].startsWith("--"))
      result[keys[key]] = argv[++i];
    else throw Error("UNKNOWN_OR_MISSING_ARGUMENT");
  }
  return result;
}
export function guardRequest(profile, input, init = {}) {
  const url = new URL(
    typeof input === "string" ? input : (input.url ?? input.href),
  );
  const expected = profile.target === "sui" ? SUI : DEEP;
  if (
    url.origin !== expected ||
    url.username ||
    url.password ||
    url.hash ||
    (profile.target === "sui"
      ? url.pathname !== RPC_PATH || url.search || init.method !== "POST"
      : url.pathname + url.search !== BOOK_PATH ||
        (init.method ?? "GET") !== "GET")
  )
    throw Error("READ_ONLY_REQUEST_ALLOWLIST");
  return url;
}
export function safeCode(error) {
  const codes = new Set([
    "ENOTFOUND",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "ERR_HTTP2_SESSION_ERROR",
    "ERR_HTTP2_STREAM_ERROR",
    "ERR_HTTP2_GOAWAY_SESSION",
    "INVALID_METADATA",
    "INVALID_ORDERBOOK",
    "READ_ONLY_REQUEST_ALLOWLIST",
    "RESPONSE_LIMIT",
    "UNEXPECTED_RPC_COUNT",
    "RATE_LIMITED",
    "CYCLE_DEADLINE",
    "RUN_DEADLINE",
    "USER_STOP",
    "REQUEST_TIMEOUT",
    "INCOMPLETE_BODY",
    "NODE_VERSION_UNSUPPORTED",
    "LIVE_DIAGNOSIS_FORBIDDEN_IN_CI",
    "INVALID_RUN_IDENTITY",
    "UNKNOWN_OR_MISSING_ARGUMENT",
    "INVALID_START_OR_OUTPUT",
    "SETUP_MISSED_START",
    "ATTEMPT_LIMIT",
    "EVIDENCE_WRITE_FAILED",
    "EVIDENCE_LIMIT",
    "EVIDENCE_BACKPRESSURE",
  ]);
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
    if (codes.has(e.code)) return e.code;
    if (codes.has(e.message)) return e.message;
    if (e.name === "TimeoutError") return "REQUEST_TIMEOUT";
    if (e.name === "AbortError") return "CANCELLED";
  }
  return "UNKNOWN_FAILURE"; // Never persist a raw exception or SDK status message.
}
export function stat(values) {
  const a = values.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    count: a.length,
    p50: a.length ? a[Math.ceil(a.length * 0.5) - 1] : null,
    p95: a.length ? a[Math.ceil(a.length * 0.95) - 1] : null,
    max: a.at(-1) ?? null,
  };
}
export function times(t, now = performance.now()) {
  const c = t.connection;
  const fresh = t.reused === false;
  const delta = (a, b) =>
    a == null || b == null ? null : Math.max(0, Math.round(a - b));
  const phase =
    t.bodyEnd != null
      ? "COMPLETE"
      : t.headersAt != null
        ? "BODY"
        : t.sentAt != null
          ? "RESPONSE"
          : c?.tlsAt != null
            ? "TLS_COMPLETE_OR_DISPATCH"
            : c?.tcpAt != null
              ? "TLS"
              : c?.dnsError
                ? "DNS"
                : c?.dnsAt != null
                  ? "TCP"
                  : c
                    ? "DNS"
                    : "UNKNOWN";
  return {
    phase,
    connectionId: c?.id ?? null,
    reusedConnection: t.reused ?? null,
    family: c?.family ?? null,
    peerAddress: c?.peerAddress ?? null,
    localPort: c?.localPort ?? null,
    protocol: c?.protocol ?? null,
    dnsMs: fresh ? delta(c?.dnsAt, c?.began) : null,
    tcpMs: fresh ? delta(c?.tcpAt, c?.dnsAt ?? c?.began) : null,
    tlsMs: fresh ? delta(c?.tlsAt, c?.tcpAt) : null,
    headersMs: delta(t.headersAt, t.began),
    responseWaitMs: delta(t.headersAt, t.sentAt),
    bodyMs: delta(t.bodyEnd, t.headersAt),
    totalMs: delta(now, t.began),
    phaseElapsedMs: delta(
      now,
      phase === "DNS"
        ? c?.began
        : phase === "TCP"
          ? c?.dnsAt
          : phase === "TLS"
            ? c?.tcpAt
            : phase === "RESPONSE"
              ? t.sentAt
              : phase === "BODY"
                ? t.headersAt
                : null,
    ),
  };
}
export function cycleStop({ failures, lastSuccessAt, now, status }) {
  if (status === 429) return "RATE_LIMITED";
  if (failures >= LIMITS.maxFailedCycles) return "CYCLES_FAILED_3_CONSECUTIVE";
  if (now - lastSuccessAt > LIMITS.noSuccessMs)
    return "NO_SUCCESSFUL_CYCLE_5MIN";
  return null;
}
export function writer(out, runId, side) {
  mkdirSync(out, { recursive: true });
  const file = join(out, "events.jsonl");
  let count = 0;
  if (existsSync(file)) throw Error("REFUSE_OVERWRITE");
  writeFileSync(file, "", { flag: "wx" });
  let pending = Promise.resolve(),
    fault = false,
    queued = 0;
  const emit = (record) => {
    if (fault) throw Error("EVIDENCE_WRITE_FAILED");
    if (++count > 5000) throw Error("EVIDENCE_LIMIT");
    const line =
      JSON.stringify({ runId, side, observedAt: Date.now(), ...record }) + "\n";
    const bytes = Buffer.byteLength(line);
    queued += bytes;
    if (queued > 1048576) throw Error("EVIDENCE_BACKPRESSURE");
    pending = pending
      .then(() => appendFile(file, line))
      .catch(() => {
        fault = true;
      })
      .finally(() => {
        queued -= bytes;
      });
  };
  emit.flush = async () => {
    await pending;
    if (fault) throw Error("EVIDENCE_WRITE_FAILED");
  };
  return emit;
}
export const stopFile = (out) => resolve(dirname(out), "STOP");
export const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
