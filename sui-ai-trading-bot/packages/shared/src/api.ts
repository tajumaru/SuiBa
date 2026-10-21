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
export type ApiPolicy = { timeoutMs?: number; maxTransientRetries?: number };
export type ApiAttempt = {
  api: string;
  success: boolean;
  code: string | null;
  latencyMs: number;
  attempt: number;
  occurredAt: number;
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
};
export class ApiAccess {
  private states = new Map<string, Stats>();
  private flights = new Map<string, Promise<unknown>>();
  private caches = new Map<string, { until: number; value: unknown }>();
  private tails = new Map<string, Promise<unknown>>();
  private controller = new AbortController();
  onAttempt: (event: ApiAttempt) => void = () => {};
  onRateLimit: (api: string) => void = () => {};
  onTransientFailure: (api: string, code: string) => void = () => {};
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
    return new Promise<void>((resolve, reject) => {
      const signal = this.controller.signal;
      const abort = () => {
        clearTimeout(timer);
        reject(new Error("API_CANCELLED"));
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
    fn: (signal: AbortSignal) => Promise<T>,
    ttl = 0,
    policy: ApiPolicy = {},
  ): Promise<T> {
    const s = this.state(api),
      id = api + ":" + key;
    if (this.controller.signal.aborted) throw new Error("API_CANCELLED");
    if (s.exhausted) throw new Error("API_RETRIES_EXHAUSTED");
    if (this.flights.has(id)) return this.flights.get(id) as Promise<T>;
    if ((s.nextRetryAt ?? 0) > Date.now()) throw new Error("API_BACKOFF");
    const cache = this.caches.get(id);
    if (cache && cache.until > Date.now()) return cache.value as T;
    this.caches.delete(id);
    const task = (async () => {
      await this.tails.get(api)?.catch(() => {});
      if (this.controller.signal.aborted) throw new Error("API_CANCELLED");
      if (s.exhausted) throw new Error("API_RETRIES_EXHAUSTED");
      if ((s.nextRetryAt ?? 0) > Date.now()) throw new Error("API_BACKOFF");
      s.active = true;
      try {
        for (let attempt = 0; ; attempt++) {
          this.controller.signal.throwIfAborted();
          if (attempt) s.retries++;
          s.requests++;
          s.recent = [
            ...s.recent.filter((t) => t > Date.now() - 60000),
            Date.now(),
          ];
          const began = Date.now();
          try {
            const result = await fn(
              AbortSignal.any([
                this.controller.signal,
                AbortSignal.timeout(policy.timeoutMs ?? apiLimits.timeoutMs),
              ]),
            );
            s.lastLatencyMs = Date.now() - began;
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
            s.lastLatencyMs = Date.now() - began;
            s.failed = true;
            const code = error instanceof Error ? error.message : "";
            if (code === "VALIDATION_RECORD_FAILED") throw error;
            const failedLatencyMs = s.lastLatencyMs;
            const failedAt = Date.now();
            const transient = [
              "UPSTREAM_TIMEOUT",
              "UPSTREAM_NETWORK_FAILED",
              "UPSTREAM_DNS_FAILED",
              "UPSTREAM_HTTP_502",
              "UPSTREAM_HTTP_503",
              "UPSTREAM_HTTP_504",
            ].includes(code);
            if (transient) this.onTransientFailure(api, code);
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
                });
              } catch {
                throw new Error("VALIDATION_RECORD_FAILED");
              }
            };
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
            await new Promise<void>((resolve, reject) => {
              const signal = this.controller.signal;
              const abort = () => {
                clearTimeout(timer);
                reject(new Error("API_CANCELLED"));
              };
              const timer = setTimeout(
                () => {
                  signal.removeEventListener("abort", abort);
                  resolve();
                },
                Math.max(0, s.nextRetryAt! - Date.now()),
              );
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
            });
          }
        }
      } finally {
        s.active = false;
      }
    })();
    this.tails.set(api, task);
    this.flights.set(id, task);
    try {
      return await task;
    } finally {
      this.flights.delete(id);
      if (this.tails.get(api) === task) this.tails.delete(api);
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
    async (signal) => {
      const combined = AbortSignal.any([
        signal,
        ...(init?.signal ? [init.signal] : []),
        ...(input instanceof Request ? [input.signal] : []),
      ]);
      try {
        const response = await rawFetch(input, { ...init, signal: combined });
        if (response.status === 429) {
          await response.body?.cancel();
          throw new RateLimited(response.headers.get("retry-after"));
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("UPSTREAM_HTTP_" + response.status);
        }
        const bytes = await response.arrayBuffer();
        return {
          bytes,
          status: response.status,
          headers: [...response.headers.entries()],
        };
      } catch (error) {
        if (
          error instanceof RateLimited ||
          (error instanceof Error &&
            /^UPSTREAM_HTTP_\d{3}$/.test(error.message))
        )
          throw error;
        if (
          init?.signal?.aborted ||
          (input instanceof Request && input.signal.aborted)
        )
          throw new Error("API_CANCELLED");
        if (combined.aborted)
          throw new Error(
            combined.reason?.name === "TimeoutError"
              ? "UPSTREAM_TIMEOUT"
              : "API_CANCELLED",
          );
        const code = (error as { cause?: { code?: string } })?.cause?.code;
        throw new Error(
          ["ENOTFOUND", "EAI_AGAIN"].includes(code ?? "")
            ? "UPSTREAM_DNS_FAILED"
            : "UPSTREAM_NETWORK_FAILED",
        );
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
