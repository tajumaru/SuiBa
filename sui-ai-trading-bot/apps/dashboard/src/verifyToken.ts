import type { VerifyResult } from "./LoginScreen.tsx";

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" && v.length > 0;

// Minimum shared envelope of current summary and legacy Worker state.
function stateEnvelope(v: unknown): boolean {
  return (
    record(v) &&
    v.mode === "PAPER" &&
    record(v.runtime) &&
    typeof v.runtime.running === "boolean" &&
    typeof v.runtime.emergency === "boolean" &&
    record(v.settings) &&
    record(v.portfolio)
  );
}
function validSummary(v: unknown): boolean {
  if (!record(v) || !record(v.frames)) return false;
  const frames = v.frames;
  return (
    v.schema === 1 &&
    typeof v.generatedAt === "number" &&
    Number.isFinite(v.generatedAt) &&
    stateEnvelope(v.summary) &&
    ["300", "900", "3600"].every((k) => text(frames[k])) &&
    text(v.recordsVersion)
  );
}
function validLegacyState(v: unknown): boolean {
  return (
    stateEnvelope(v) &&
    record(v) &&
    ["candles", "trades", "orders", "riskEvents"].every((k) =>
      Array.isArray(v[k]),
    )
  );
}

/** Read-only probe: one 8s deadline includes fallback and body reads.
 * AbortController works on Safari without AbortSignal.any/timeout helpers. */
export async function verifyToken(
  candidate: string,
  signal?: AbortSignal,
  request: typeof fetch = globalThis.fetch,
): Promise<VerifyResult> {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 8000);
  const checkAbort = () => {
    if (controller.signal.aborted) throw Error("ABORTED");
  };
  const attempt = async (
    path: string,
    valid: (v: unknown) => boolean,
  ): Promise<VerifyResult & { status: number }> => {
    checkAbort();
    const r = await request("/api/" + path, {
      signal: controller.signal,
      headers: { Authorization: "Bearer " + candidate },
      cache: "no-store",
      redirect: "error",
    });
    checkAbort();
    const status = r.status;
    // HTTP status is authoritative even for malformed error bodies.
    if (status === 401) return { ok: false, code: "UNAUTHORIZED", status };
    if (!r.ok) return { ok: false, code: `HTTP_${status}`, status };
    if (
      !/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(
        r.headers.get("content-type") ?? "",
      )
    )
      return { ok: false, code: "INVALID_RESPONSE", status };
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      checkAbort();
      return { ok: false, code: "INVALID_RESPONSE", status };
    }
    checkAbort();
    return valid(body)
      ? { ok: true, status }
      : { ok: false, code: "INVALID_RESPONSE", status };
  };
  try {
    const first = await attempt("dashboard/summary", validSummary);
    if (first.ok || first.status !== 404) return first;
    return await attempt("state", validLegacyState);
  } catch {
    return {
      ok: false,
      code: signal?.aborted ? "CANCELLED" : timedOut ? "TIMEOUT" : "NETWORK",
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}
