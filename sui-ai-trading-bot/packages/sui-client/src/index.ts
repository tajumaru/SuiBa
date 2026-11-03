import { apiFetch, rawFetch } from "../../shared/src/api.ts";
import {
  abortable,
  currentReadBudget,
  type ReadBudget,
} from "../../shared/src/read-budget.ts";
import {
  SuiGrpcClient,
  GrpcWebFetchTransport,
  GrpcStatusCode,
  RpcError,
} from "@mysten/sui/grpc";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  PassiveSuiDiagnostics,
  type NetworkObservation,
  type NetworkTrace,
} from "./diagnostics.ts";
import { isValidSuiAddress, isValidTransactionDigest } from "@mysten/sui/utils";
import { coin, decimals, SUI, USDC } from "../../shared/src/index.ts";
export interface SuiObservation {
  transportId: string;
  layer: "HTTP" | "GRPC" | "METADATA" | "READ" | "HEALTH";
  operation: "METADATA" | "BALANCE" | "TRANSACTION" | "HEALTH";
  requestId: string;
  rpcId?: string;
  healthId?: string;
  cycleId?: string;
  coin?: "SUI" | "USDC";
  at: number;
  elapsedMs: number;
  success: boolean;
  code: string | null;
  cacheHit?: boolean;
  httpStatus?: number | null;
  /** False for shared flights or local rejection; exclude from HTTP attempt counts. */
  transportAttempted?: boolean;
  grpcStatus?: string;
  grpcStatusSource?: "SDK";
  network?: NetworkObservation;
}
type ReadContext = {
  operation: SuiObservation["operation"];
  requestId: string;
  rpcId?: string;
  healthId?: string;
  cycleId?: string;
  coin?: "SUI" | "USDC";
  pending: Promise<void>[];
};
export interface SuiClientOptions {
  /** Must persist synchronously; async callbacks fail closed without awaiting I/O. */
  onObservation?: (event: SuiObservation) => void;
  /** Test/embedding hook; no dispatcher, protocol or retry changes by default. */
  fetch?: typeof fetch;
  /**
   * Additional gRPC base URLs (origin only, no path) that serve
   * the same reads when the active endpoint fails at transport
   * level or answers 502/503/504. Switching is sticky: traffic
   * stays on the endpoint that served until it fails, then
   * advances, wrapping around. The logical API stays "Sui gRPC"
   * for backoff and failure classification regardless of which
   * endpoint served a request.
   */
  fallbackUrls?: string[];
}
type HealthStatus = { healthy: boolean; checkedAt: number; failures: number };
const transportCode = (error: unknown) => {
  const value = error instanceof Error ? error.message : "";
  return [
    "UPSTREAM_TIMEOUT",
    "UPSTREAM_DNS_FAILED",
    "UPSTREAM_CONNECT_TIMEOUT",
    "UPSTREAM_TLS_FAILED",
    "UPSTREAM_HEADERS_TIMEOUT",
    "UPSTREAM_BODY_TIMEOUT",
    "UPSTREAM_NETWORK_FAILED",
    "API_CANCELLED",
    "API_BACKOFF",
    "API_RETRIES_EXHAUSTED",
    "MARKET_DATA_STALLED",
    "VALIDATION_RECORD_FAILED",
  ].includes(value) || /^UPSTREAM_HTTP_[45]\d\d$/.test(value)
    ? value
    : "SUI_READ_FAILED";
};
export class ReadOnlySuiClient {
  private client: SuiGrpcClient;
  private scope = new AsyncLocalStorage<ReadContext>();
  private diagnostics: PassiveSuiDiagnostics;
  private observationFault = false;
  private epoch = 0;
  private readonly endpoints: string[];
  private activeEndpoint = 0;
  private readonly transportId = randomUUID();
  private pendingHealth?: {
    promise: Promise<HealthStatus>;
    fresh: boolean;
    budget?: ReadBudget;
    epoch: number;
  };
  readonly readStatus = {
    healthy: false,
    checkedAt: 0,
    failures: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    /** Hostname (no port or credentials) of the endpoint that
     * served the most recent transport attempt. */
    endpoint: "",
  };
  status: { healthy: boolean; checkedAt: number; failures: number } = {
    healthy: false,
    checkedAt: 0,
    failures: 0,
  };
  constructor(
    url = "https://fullnode.mainnet.sui.io:443",
    private options: SuiClientOptions = {},
  ) {
    const endpoints = [url, ...(options.fallbackUrls ?? [])].filter(
      (u, i, a) => a.indexOf(u) === i,
    );
    for (const endpoint of endpoints) {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
      // Endpoints are retargeted by origin; a path prefix would
      // silently change the gRPC method paths, so it is refused.
      if (parsed.pathname !== "/" || parsed.search || parsed.hash)
        throw new Error("ENDPOINT_MUST_BE_ORIGIN");
    }
    this.endpoints = endpoints;
    this.readStatus.endpoint = new URL(endpoints[0]).hostname;
    this.diagnostics = new PassiveSuiDiagnostics(new URL(url).origin);
    const transport = new GrpcWebFetchTransport({
      baseUrl: url,
      fetch: (input, init) => this.http(input, init),
    });
    // Install before SDK construction: it binds and retains the transport method.
    const original = transport.unary.bind(transport);
    transport.unary = (method, input, settings) => {
      const parent = this.scope.getStore();
      if (!parent) return original(method, input, settings);
      const context = { ...parent, rpcId: randomUUID() };
      return this.scope.run(context, () => {
        const began = performance.now();
        const call = original(method, input, settings);
        const observed = Promise.all([call.response, call.status]).then(
          ([, status]) =>
            this.emit(
              context,
              "GRPC",
              began,
              status.code === "OK",
              status.code === "OK" ? null : "GRPC_FAILED",
              {
                grpcStatus:
                  typeof GrpcStatusCode[
                    status.code as keyof typeof GrpcStatusCode
                  ] === "number"
                    ? status.code
                    : "UNKNOWN",
                grpcStatusSource: "SDK",
              },
            ),
          (error: unknown) => {
            const code =
              error instanceof RpcError &&
              typeof GrpcStatusCode[
                error.code as keyof typeof GrpcStatusCode
              ] === "number"
                ? error.code
                : "UNKNOWN";
            this.emit(context, "GRPC", began, false, "GRPC_FAILED", {
              grpcStatus: code,
              grpcStatusSource: "SDK",
            });
          },
        );
        parent.pending.push(observed);
        return call;
      });
    };
    this.client = new SuiGrpcClient({
      network: "mainnet",
      transport,
    });
  }
  private emit(
    context: ReadContext,
    layer: SuiObservation["layer"],
    began: number,
    success: boolean,
    code: string | null,
    extra: Partial<
      Pick<
        SuiObservation,
        | "network"
        | "httpStatus"
        | "transportAttempted"
        | "grpcStatus"
        | "grpcStatusSource"
        | "cacheHit"
      >
    > = {},
  ) {
    // A sticky storage fault already closes the gate. Never repeat blocking I/O.
    if (this.observationFault) return;
    // No raw error/status text, URL, request, header, body, address or digest is persisted.
    try {
      const result: unknown = this.options.onObservation?.({
        transportId: this.transportId,
        layer,
        operation: context.operation,
        requestId: context.requestId,
        rpcId: context.rpcId,
        healthId: context.healthId,
        cycleId: context.cycleId,
        coin: context.coin,
        at: Date.now(),
        elapsedMs: Math.max(0, Math.round(performance.now() - began)),
        success,
        code,
        ...extra,
      });
      if (
        result &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        // TypeScript permits async functions in void callbacks. Pending storage
        // cannot serve as evidence; consume rejection without waiting for I/O.
        void Promise.resolve(result).catch(() => {});
        throw Error("VALIDATION_RECORD_FAILED");
      }
    } catch {
      this.observationFault = true;
      this.epoch++;
      this.status = { ...this.status, healthy: false };
      this.readStatus.healthy = false;
    }
  }
  private assertEvidence() {
    if (this.observationFault) throw Error("VALIDATION_RECORD_FAILED");
  }
  private async http(input: Parameters<typeof fetch>[0], init?: RequestInit) {
    const context = this.scope.getStore()!;
    const trace = this.diagnostics.trace();
    let status: number | null = null;
    let transportAttempted = false;
    return this.diagnostics.run(trace, async () => {
      try {
        const response = await apiFetch("Sui gRPC", input, init, 0, {
          transport: async (target, settings) => {
            transportAttempted = true;
            const response = await this.fetchAcrossEndpoints(
              target,
              settings,
              trace,
            );
            status = response.status;
            return response;
          },
        });
        this.emit(context, "HTTP", trace.began, true, null, {
          httpStatus: response.status,
          transportAttempted,
          ...(transportAttempted
            ? { network: this.diagnostics.snapshot(trace) }
            : {}),
        });
        this.assertEvidence();
        return response;
      } catch (error) {
        if (!this.observationFault)
          this.emit(context, "HTTP", trace.began, false, transportCode(error), {
            httpStatus: status,
            transportAttempted,
            ...(transportAttempted
              ? { network: this.diagnostics.snapshot(trace) }
              : {}),
          });
        throw error;
      }
    });
  }
  /** Points a transport target at another endpoint's origin,
   * keeping the gRPC method path untouched. */
  private retarget(
    target: Parameters<typeof fetch>[0],
    baseUrl: string,
  ): Parameters<typeof fetch>[0] {
    const base = new URL(baseUrl);
    if (typeof target === "string" || target instanceof URL) {
      const u = new URL(target.toString());
      u.protocol = base.protocol;
      u.host = base.host;
      return u.toString();
    }
    if (target instanceof Request) {
      const u = new URL(target.url);
      u.protocol = base.protocol;
      u.host = base.host;
      return new Request(u, target);
    }
    return target;
  }
  /**
   * One transport attempt, served by the active endpoint. A
   * transport-level failure or a gateway-class answer (502 /
   * 503 / 504) advances to the next endpoint within the same
   * attempt; the endpoint that serves becomes the sticky active
   * one. When every endpoint fails the same way a single
   * endpoint would have — the last error is thrown, or the last
   * gateway response is returned for apiFetch to classify — so
   * backoff, failure records and recovery classification see
   * exactly today's behaviour, only with more chances first.
   * A caller-side abort is never an endpoint failure.
   */
  private async fetchAcrossEndpoints(
    target: Parameters<typeof fetch>[0],
    settings: RequestInit | undefined,
    trace: NetworkTrace,
  ): Promise<Response> {
    let lastError: unknown;
    let lastResponse: Response | undefined;
    for (let tried = 0; tried < this.endpoints.length; tried++) {
      const index = (this.activeEndpoint + tried) % this.endpoints.length;
      let response: Response;
      try {
        response = await (this.options.fetch ?? rawFetch)(
          this.retarget(target, this.endpoints[index]),
          settings,
        );
      } catch (error) {
        if (
          settings?.signal?.aborted ||
          (error instanceof Error && error.name === "AbortError")
        )
          throw error;
        lastError = this.diagnostics.failure(error, trace);
        continue;
      }
      if (
        response.status >= 502 &&
        response.status <= 504 &&
        tried < this.endpoints.length - 1
      ) {
        await response.arrayBuffer().catch(() => undefined);
        lastResponse = response;
        continue;
      }
      this.activeEndpoint = index;
      this.readStatus.endpoint = new URL(this.endpoints[index]).hostname;
      trace.headersAt ??= performance.now();
      trace.phase = "BODY";
      return response;
    }
    if (lastResponse) {
      trace.headersAt ??= performance.now();
      trace.phase = "BODY";
      return lastResponse;
    }
    throw lastError;
  }
  private async read<T>(
    operation: ReadContext["operation"],
    type: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const budget = currentReadBudget(),
      epoch = this.epoch,
      began = performance.now();
    const context: ReadContext = {
      operation,
      requestId: randomUUID(),
      healthId: this.scope.getStore()?.healthId,
      cycleId: budget?.cycleId,
      coin: type === SUI ? "SUI" : type === USDC ? "USDC" : undefined,
      pending: [],
    };
    return this.scope.run(context, async () => {
      let invalidated = false;
      try {
        budget?.signal.throwIfAborted();
        this.assertEvidence();
        const task = fn();
        const value = await (budget ? abortable(task, budget.signal) : task);
        if (!budget?.signal.aborted) await Promise.all(context.pending);
        budget?.signal.throwIfAborted();
        this.assertEvidence();
        this.emit(
          context,
          operation === "METADATA" ? "METADATA" : "READ",
          began,
          true,
          null,
        );
        invalidated = epoch !== this.epoch;
        if (invalidated) throw Error("SUI_READ_FAILED");
        this.assertEvidence();
        Object.assign(this.readStatus, {
          healthy: true,
          checkedAt: Date.now(),
          lastSuccessAt: Date.now(),
          failures: 0,
        });
        return value;
      } catch (error) {
        if (!budget?.signal.aborted) await Promise.all(context.pending);
        if (!invalidated) this.epoch++;
        this.status = { ...this.status, healthy: false };
        Object.assign(this.readStatus, {
          healthy: false,
          checkedAt: Date.now(),
          lastFailureAt: Date.now(),
          failures: this.readStatus.failures + 1,
        });
        const code =
          error instanceof Error &&
          [
            "INVALID_METADATA",
            "INVALID_BALANCE",
            "INVALID_TRANSACTION",
          ].includes(error.message)
            ? error.message
            : "SUI_READ_FAILED";
        if (!invalidated)
          this.emit(
            context,
            operation === "METADATA" ? "METADATA" : "READ",
            began,
            false,
            code,
          );
        this.assertEvidence();
        throw new Error("SUI_READ_FAILED");
      }
    });
  }

  async balance(owner: string, type: string) {
    if (!isValidSuiAddress(owner)) throw new Error("INVALID_ADDRESS");
    const t = coin(type);
    return this.read("BALANCE", t, async () => {
      const { balance } = await this.client.getBalance({
        owner,
        coinType: t,
        signal: currentReadBudget()?.signal,
      });
      if (coin(balance.coinType) !== t || !/^\d+$/.test(balance.balance))
        throw new Error("INVALID_BALANCE");
      return { coinType: t, atomic: balance.balance, decimals: decimals(t) };
    });
  }
  async metadata(type: string) {
    const t = coin(type);
    return this.read("METADATA", t, async () => {
      const { coinMetadata } = await this.client.getCoinMetadata({
        coinType: t,
        signal: currentReadBudget()?.signal,
      });
      if (!coinMetadata || coinMetadata.decimals !== decimals(t))
        throw new Error("INVALID_METADATA");
      return { coinType: t, ...coinMetadata };
    });
  }
  async transaction(digest: string) {
    if (!isValidTransactionDigest(digest)) throw new Error("INVALID_DIGEST");
    return this.read("TRANSACTION", undefined, async () => {
      const r = await this.client.getTransaction({
        digest,
        include: { effects: true },
        signal: currentReadBudget()?.signal,
      });
      const tx = r.Transaction ?? r.FailedTransaction;
      if (!tx || tx.digest !== digest) throw new Error("INVALID_TRANSACTION");
      return r;
    });
  }
  async health(force = false): Promise<HealthStatus> {
    const budget = currentReadBudget(),
      fresh = force || !!budget?.fresh;
    budget?.signal.throwIfAborted();
    this.assertEvidence();
    const pending = this.pendingHealth;
    if (pending) {
      const wait = <T>(task: Promise<T>) =>
        budget ? abortable(task, budget.signal) : task;
      if (
        pending.epoch === this.epoch &&
        (!fresh || (pending.fresh && pending.budget === budget))
      )
        return wait(pending.promise);
      await wait(pending.promise.catch(() => undefined));
      return this.health(force);
    }
    const context: ReadContext = {
      operation: "HEALTH",
      requestId: randomUUID(),
      cycleId: budget?.cycleId,
      pending: [],
    };
    context.healthId = context.requestId;
    const began = performance.now();
    if (
      !fresh &&
      this.status.healthy &&
      Date.now() - this.status.checkedAt < 120000
    ) {
      this.emit(context, "HEALTH", began, true, null, { cacheHit: true });
      this.assertEvidence();
      return { ...this.status };
    }
    const epoch = this.epoch;
    this.status = { ...this.status, healthy: false };
    const promise = this.scope.run(context, async () => {
      const results = await Promise.allSettled([
        this.metadata(SUI),
        this.metadata(USDC),
      ]);
      const success =
        results.every((r) => r.status === "fulfilled") &&
        this.epoch === epoch &&
        !budget?.signal.aborted &&
        !this.observationFault;
      if (!success) {
        this.status = {
          healthy: false,
          checkedAt: Date.now(),
          failures: this.status.failures + 1,
        };
        this.emit(context, "HEALTH", began, false, "SUI_READ_FAILED", {
          cacheHit: false,
        });
        this.assertEvidence();
        throw Error("SUI_READ_FAILED");
      }
      this.emit(context, "HEALTH", began, true, null, { cacheHit: false });
      this.assertEvidence();
      this.status = { healthy: true, checkedAt: Date.now(), failures: 0 };
      return { ...this.status };
    });
    this.pendingHealth = { promise, fresh, budget, epoch };
    try {
      return await promise;
    } finally {
      if (this.pendingHealth?.promise === promise)
        this.pendingHealth = undefined;
    }
  }
  close() {
    this.diagnostics.close();
    this.scope.disable();
  }
}
