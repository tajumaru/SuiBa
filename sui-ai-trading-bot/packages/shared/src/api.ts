import {
  classifyHttpFailure,
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
type Stats = {
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
  onRateLimit: (api: string) => void = () => {};
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
    return ["Sui gRPC", "GeckoTerminal", "Cetus"].map((api) => {
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
  async run<T>(
    api: string,
    key: string,
    fn: (signal: AbortSignal) => Promise<T>,
    ttl = 0,
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
          try {
            const result = await fn(
              AbortSignal.any([
                this.controller.signal,
                AbortSignal.timeout(apiLimits.timeoutMs),
              ]),
            );
            s.failed = false;
            s.nextRetryAt = null;
            s.lastSuccessAt = Date.now();
            if (ttl)
              this.caches.set(id, { value: result, until: Date.now() + ttl });
            return result;
          } catch (error) {
            s.failed = true;
            if (!(error instanceof RateLimited)) throw error;
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
      const started = performance.now();
      let phase: RequestPhase = "HEADERS_OR_CONNECT";
      let status: number | null = null;
      const combined = AbortSignal.any([
        signal,
        ...(init?.signal
          ? [init.signal]
          : input instanceof Request
            ? [input.signal]
            : []),
      ]);
      try {
        const response = await rawFetch(input, { ...init, signal: combined });
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
        return {
          bytes,
          status: response.status,
          headers: [...response.headers.entries()],
        };
      } catch (error) {
        const classification =
          error instanceof RateLimited || error instanceof HttpStatusFailure
            ? { code: error.message, phase: "HTTP" as const, causeCode: null }
            : classifyHttpFailure(error, phase, combined);
        apiAccess.recordFailure({
          ...requestIdentity(
            api,
            url,
            init?.method ?? (input instanceof Request ? input.method : "GET"),
          ),
          ...classification,
          status,
          elapsedMs: Math.round(performance.now() - started),
          occurredAt: Date.now(),
        });
        if (error instanceof RateLimited || error instanceof HttpStatusFailure)
          throw error;
        throw new Error(classification.code);
      }
    },
    ttl,
  );
  return new Response(value.bytes.slice(0), {
    status: value.status,
    headers: value.headers,
  });
}
