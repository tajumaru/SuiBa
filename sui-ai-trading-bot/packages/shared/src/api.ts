import { currentReadBudget, abortable } from "./read-budget.ts";
import {
  classifyHttpFailure,
  transportDiagnostics,
  requestIdentity,
  HttpStatusFailure,
  type ApiFailure,
  type RequestPhase,
} from "./http-errors.ts";
export const apiLimits = {
  timeoutMs: 10000,
  maxWaitMs: 60000,
  maxRetries: 2,
  baseMs: 1000,
};
export function retryAfter(
  value: string | null,
  now = Date.now(),
): number | null {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim()))
    return Math.min(8e15, Number(value) * 1000);
  if (
    !/^(?:[A-Za-z]{3,9},.*GMT|[A-Za-z]{3} [A-Za-z]{3} .*\d{4})$/.test(
      value.trim(),
    )
  )
    return null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
export function retryDelay(
  attempt: number,
  after: number | null,
  random = Math.random(),
) {
  const minimum = after ?? apiLimits.baseMs * 2 ** attempt;
  return Math.min(
    apiLimits.maxWaitMs,
    minimum + Math.max(0, Math.min(1, random)) * Math.min(1000, minimum * 0.25),
  );
}
export type ApiPolicy = {
  timeoutMs?: number;
  maxTransientRetries?: number;
  transport?: typeof fetch;
};
export type ApiAttempt = {
  api: string;
  success: boolean;
  code: string | null;
  latencyMs: number;
  attempt: number;
  occurredAt: number;
  failure?: ApiFailure;
};
type Stats = {
  lastLatencyMs: number | null;
  requests: number;
  rateLimits: number;
  retries: number;
  lastSuccessAt: number | null;
  nextRetryAt: number | null;
  exhausted: boolean;
  active: boolean;
  failed: boolean;
  recent: number[];
  lastFailure: ApiFailure | null;
};
export class ApiAccess {
  private states = new Map<string, Stats>();
  private flights = new Map<string, Promise<unknown>>();
  private caches = new Map<string, { until: number; value: unknown }>();
  private tails = new Map<string, Promise<unknown>>();
  private controller = new AbortController();
  onAttempt: (event: ApiAttempt) => void = () => {};
  onRateLimit: (api: string) => void = () => {};
  onTransientFailure: (
    api: string,
    code: string,
    failure?: ApiFailure,
  ) => void = () => {};
  onFailure: (failure: ApiFailure) => void = () => {};
  recordFailure(failure: ApiFailure) {
    this.state(failure.api).lastFailure = failure;
    this.onFailure(failure);
  }
  restoreCooldowns(
    values: { api: string; nextRetryAt: number | null; exhausted: boolean }[],
  ) {
    for (const value of values) {
      const s = this.state(value.api);
      s.nextRetryAt = value.nextRetryAt;
      s.exhausted = value.exhausted;
    }
  }
  private state(api: string) {
    if (!this.states.has(api))
      this.states.set(api, {
        lastLatencyMs: null,
        requests: 0,
        rateLimits: 0,
        retries: 0,
        lastSuccessAt: null,
        nextRetryAt: null,
        exhausted: false,
        active: false,
        failed: false,
        recent: [],
        lastFailure: null,
      });
    return this.states.get(api)!;
  }
  snapshot(now = Date.now()) {
    return [
      ...new Set(["Sui gRPC", "GeckoTerminal", "Cetus", ...this.states.keys()]),
    ].map((api) => {
      const s = this.state(api);
      return {
        api,
        ...s,
        recent: undefined,
        requestsPerMinute: s.recent.filter((t) => t > now - 60000).length,
        backoff: s.nextRetryAt !== null && s.nextRetryAt > now,
        delayed: s.lastSuccessAt === null || now - s.lastSuccessAt > 180000,
      };
    });
  }
  blocked() {
    return [...this.states.values()].some(
      (s) => s.exhausted || (s.nextRetryAt ?? 0) > Date.now(),
    );
  }
  reset() {
    if (
      [...this.states.values()].some(
        (s) => s.active || (s.nextRetryAt ?? 0) > Date.now(),
      )
    )
      throw new Error("API_BACKOFF");
    for (const s of this.states.values()) s.exhausted = false;
  }
  cancel() {
    this.controller.abort();
    this.caches.clear();
  }
  private wait(until: number) {
    const budget = currentReadBudget();
    return new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.any([
        this.controller.signal,
        ...(budget ? [budget.signal] : []),
      ]);
      const abort = () => {
        clearTimeout(timer);
        reject(
          budget?.signal.aborted
            ? budget.signal.reason
            : new Error("API_CANCELLED"),
        );
      };
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        Math.max(0, until - Date.now()),
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  async run<T>(
    api: string,
    key: string,
    fn: (
      signal: AbortSignal,
      context: { attempt: number; lastSuccessAt: number | null },
    ) => Promise<T>,
    ttl = 0,
    policy: ApiPolicy = {},
  ): Promise<T> {
    const budget = currentReadBudget();
    budget?.signal.throwIfAborted();
    if (budget?.fresh) ttl = 0;
    const s = this.state(api),
      id = api + ":" + key;
    if (this.controller.signal.aborted) throw new Error("API_CANCELLED");
    if (s.exhausted) throw new Error("API_RETRIES_EXHAUSTED");
    if (this.flights.has(id)) {
      const pending = this.flights.get(id) as Promise<T>;
      if (!budget?.fresh)
        return budget ? abortable(pending, budget.signal) : pending;
      // Recovery proof must originate in this acquisition, not an older flight.
      await abortable(
        pending.catch(() => {}),
        budget.signal,
      );
      budget.signal.throwIfAborted();
      return this.run(api, key, fn, 0, policy);
    }
    if ((s.nextRetryAt ?? 0) > Date.now()) throw new Error("API_BACKOFF");
    const cache = this.caches.get(id);
    if (!budget?.fresh && cache && cache.until > Date.now())
      return cache.value as T;
    this.caches.delete(id);
    const task = (async () => {
      const tail = this.tails.get(api);
      if (tail) {
        const settled = tail.catch(() => {});
        await (budget ? abortable(settled, budget.signal) : settled);
      }
      budget?.signal.throwIfAborted();
      if (this.controller.signal.aborted) throw new Error("API_CANCELLED");
      if (s.exhausted) throw new Error("API_RETRIES_EXHAUSTED");
      if ((s.nextRetryAt ?? 0) > Date.now()) throw new Error("API_BACKOFF");
      s.active = true;
      try {
        for (let attempt = 0; ; attempt++) {
          this.controller.signal.throwIfAborted();
          budget?.signal.throwIfAborted();
          if (attempt) s.retries++;
          s.requests++;
          s.recent = [
            ...s.recent.filter((t) => t > Date.now() - 60000),
            Date.now(),
          ];
          const began = performance.now();
          const previousFailure = s.lastFailure;
          const attemptSignal = AbortSignal.any([
            this.controller.signal,
            ...(budget ? [budget.signal] : []),
            AbortSignal.timeout(policy.timeoutMs ?? apiLimits.timeoutMs),
          ]);
          try {
            const result = await fn(attemptSignal, {
              attempt,
              lastSuccessAt: s.lastSuccessAt,
            });
            attemptSignal.throwIfAborted();
            s.lastLatencyMs = Math.max(
              0,
              Math.round(performance.now() - began),
            );
            s.failed = false;
            s.nextRetryAt = null;
            s.lastSuccessAt = Date.now();
            if (ttl)
              this.caches.set(id, { value: result, until: Date.now() + ttl });
            // Observer failure must not turn a successful request into a retry.
            try {
              this.onAttempt({
                api,
                success: true,
                code: null,
                latencyMs: s.lastLatencyMs,
                attempt,
                occurredAt: Date.now(),
              });
            } catch {
              throw new Error("VALIDATION_RECORD_FAILED");
            }
            return result;
          } catch (error) {
            s.lastLatencyMs = Math.max(
              0,
              Math.round(performance.now() - began),
            );
            s.failed = true;
            const code = error instanceof Error ? error.message : "";
            if (code === "VALIDATION_RECORD_FAILED") throw error;
            const failedLatencyMs = s.lastLatencyMs;
            const failedAt = Date.now();
            const transient = [
              "UPSTREAM_TIMEOUT",
              "UPSTREAM_CONNECT_TIMEOUT",
              "UPSTREAM_HEADERS_TIMEOUT",
              "UPSTREAM_BODY_TIMEOUT",
              "UPSTREAM_NETWORK_FAILED",
              "UPSTREAM_DNS_FAILED",
              "UPSTREAM_HTTP_502",
              "UPSTREAM_HTTP_503",
              "UPSTREAM_HTTP_504",
            ].includes(code);
            if (transient && !budget?.signal.aborted)
              this.onTransientFailure(
                api,
                code,
                s.lastFailure !== previousFailure
                  ? (s.lastFailure ?? undefined)
                  : undefined,
              );
            // Stop first: monitoring I/O must never delay the safety callback.
            const recordFailure = () => {
              try {
                this.onAttempt({
                  api,
                  success: false,
                  code: /^[A-Z0-9_]{1,100}$/.test(code)
                    ? code
                    : "UNKNOWN_FAILURE",
                  latencyMs: failedLatencyMs,
                  attempt,
                  occurredAt: failedAt,
                  ...(s.lastFailure && s.lastFailure !== previousFailure
                    ? { failure: s.lastFailure }
                    : {}),
                });
              } catch {
                throw new Error("VALIDATION_RECORD_FAILED");
              }
            };
            if (budget?.signal.aborted) {
              recordFailure();
              throw budget.signal.reason;
            }
            if (!(error instanceof RateLimited)) {
              recordFailure();
              if (
                !transient ||
                attempt >= Math.min(2, policy.maxTransientRetries ?? 0)
              )
                throw error;
              s.nextRetryAt = Date.now() + retryDelay(attempt, null);
              await this.wait(s.nextRetryAt);
              continue;
            }
            s.rateLimits++;
            this.caches.clear();
            const after = retryAfter(error.after);
            s.nextRetryAt = Date.now() + retryDelay(attempt, after);
            // A long server cooldown is honored by refusing automatic retries.
            if (after !== null && after > apiLimits.maxWaitMs)
              s.nextRetryAt = Date.now() + after;
            s.exhausted =
              attempt >= apiLimits.maxRetries ||
              (after !== null && after > apiLimits.maxWaitMs);
            this.onRateLimit(api);
            recordFailure();
            if (s.exhausted) throw new Error("API_RETRIES_EXHAUSTED");
            await this.wait(s.nextRetryAt);
          }
        }
      } finally {
        s.active = false;
      }
    })();
    // A canceled queued request must not erase its still-active predecessor.
    const predecessor = this.tails.get(api);
    const tail = Promise.allSettled([
      ...(predecessor ? [predecessor] : []),
      task,
    ]).then(() => {});
    this.tails.set(api, tail);
    void tail.then(() => {
      if (this.tails.get(api) === tail) this.tails.delete(api);
    });
    this.flights.set(id, task);
    try {
      return await task;
    } finally {
      this.flights.delete(id);
    }
  }
}
export class RateLimited extends Error {
  constructor(readonly after: string | null = null) {
    super("UPSTREAM_HTTP_429");
  }
}
export const apiAccess = new ApiAccess();
export const rawFetch = globalThis.fetch.bind(globalThis);
const readSuccesses = new Map<string, number>();
export async function apiFetch(
  api: string,
  input: string | URL | Request,
  init?: RequestInit,
  ttl = 0,
  policy: ApiPolicy = {},
) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  // Only read-only calls use this transport. Keys never appear in snapshots/logs.
  const body =
    init?.body ??
    (input instanceof Request ? await input.clone().arrayBuffer() : "");
  const bodyKey =
    typeof body === "string"
      ? body
      : body instanceof ArrayBuffer
        ? Array.from(new Uint8Array(body)).join(",")
        : ArrayBuffer.isView(body)
          ? Array.from(
              new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
            ).join(",")
          : String(Math.random());
  const key = `${init?.method ?? (input instanceof Request ? input.method : "GET")}:${url}:${bodyKey}`;
  const value = await apiAccess.run(
    api,
    key,
    async (signal, context) => {
      const started = performance.now(),
        startedAt = Date.now();
      const identity = requestIdentity(
        api,
        url,
        init?.method ?? (input instanceof Request ? input.method : "GET"),
      );
      const operationKey =
        identity.api +
        ":" +
        identity.operation +
        ":" +
        (identity.timeframe ?? "");
      let phase: RequestPhase = "HEADERS_OR_CONNECT";
      let status: number | null = null;
      const combined = AbortSignal.any([
        signal,
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : []),
      ]);
      try {
        currentReadBudget()?.signal.throwIfAborted();
        const response = await (policy.transport ?? rawFetch)(input, {
          ...init,
          signal: combined,
        });
        status = response.status;
        if (!response.ok) {
          phase = "HTTP";
          await response.body?.cancel().catch(() => {});
          if (status === 429)
            throw new RateLimited(response.headers.get("retry-after"));
          throw new HttpStatusFailure(status);
        }
        phase = "BODY";
        const bytes = await response.arrayBuffer();
        readSuccesses.set(operationKey, Date.now());
        return {
          bytes,
          status: response.status,
          headers: [...response.headers.entries()],
        };
      } catch (error) {
        const detail = transportDiagnostics(error);
        status ??= detail.status ?? null;
        const classification =
          error instanceof RateLimited || error instanceof HttpStatusFailure
            ? { code: error.message, phase: "HTTP" as const, causeCode: null }
            : classifyHttpFailure(error, detail.phase ?? phase, combined);
        apiAccess.recordFailure({
          ...identity,
          ...classification,
          ...(detail.timings ? { transportTimings: detail.timings } : {}),
          status,
          startedAt,
          endedAt: Date.now(),
          retryCount: context.attempt,
          lastSuccessAt: readSuccesses.get(operationKey) ?? null,
          lastApiSuccessAt: context.lastSuccessAt,
          timeoutType: classification.code.includes("TIMEOUT")
            ? classification.phase
            : null,
          elapsedMs: Math.round(performance.now() - started),
          occurredAt: Date.now(),
        });
        if (error instanceof RateLimited || error instanceof HttpStatusFailure)
          throw error;
        throw new Error(classification.code);
      }
    },
    ttl,
    policy,
  );
  return new Response(value.bytes.slice(0), {
    status: value.status,
    headers: value.headers,
  });
}
