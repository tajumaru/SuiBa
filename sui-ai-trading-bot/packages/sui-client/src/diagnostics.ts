import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

export type NetworkPhase =
  "UNKNOWN" | "DNS" | "CONNECT" | "TLS" | "RESPONSE" | "BODY";
export interface NetworkObservation {
  phase: NetworkPhase;
  connectionId?: number;
  reusedConnection?: boolean;
  protocol?: "h1" | "h2";
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
  headersMs?: number;
  responseWaitMs?: number;
  bodyMs?: number;
  totalMs: number;
  phaseElapsedMs?: number;
  // Count TCP family selection attempts, not additional application/RPC attempts.
  tcpAttempts?: number;
  family?: 4 | 6;
  available: boolean;
}
type Connection = {
  id: number;
  began: number;
  phase: NetworkPhase;
  lookupAt?: number;
  connectedAt?: number;
  secureAt?: number;
  sent: number;
  attempts: number;
  family?: 4 | 6;
  protocol?: "h1" | "h2";
};
export type NetworkTrace = {
  began: number;
  phase: NetworkPhase;
  connection?: Connection;
  reused?: boolean;
  sentAt?: number;
  bodySentAt?: number;
  headersAt?: number;
  expectedConnection?: boolean;
};

/** Passive listeners only: never resolve DNS, send PINGs or replace the dispatcher. */
export class PassiveSuiDiagnostics {
  private scope = new AsyncLocalStorage<NetworkTrace>();
  private requests = new WeakMap<object, NetworkTrace>();
  private sockets = new WeakMap<object, Connection>();
  private listeners = new Set<() => void>();
  private subscriptions: (() => void)[] = [];
  private serial = 0;
  private available = true;
  private closed = false;
  constructor(private origin: string) {
    this.subscribe(
      "undici:client:beforeConnect",
      ({
        connectParams,
      }: {
        connectParams: {
          hostname?: string;
          port?: string | number;
          protocol?: string;
        };
      }) => {
        const trace = this.scope.getStore();
        if (!trace) return;
        const url = new URL(this.origin);
        trace.expectedConnection =
          connectParams.hostname === url.hostname &&
          String(
            connectParams.port ||
              (connectParams.protocol === "https:" ? 443 : 80),
          ) === (url.port || (url.protocol === "https:" ? "443" : "80"));
      },
    );
    this.subscribe("net.client.socket", ({ socket }: { socket: TLSSocket }) => {
      const trace = this.scope.getStore();
      if (!trace?.expectedConnection || this.sockets.has(socket)) return;
      trace.expectedConnection = false;
      // Bound retained listeners even if a future pool configuration opens many sockets.
      if (this.listeners.size >= 64) {
        this.available = false;
        return;
      }
      const c: Connection = {
        id: ++this.serial,
        began: performance.now(),
        phase: "DNS",
        sent: 0,
        attempts: 0,
      };
      trace.connection = c;
      this.sockets.set(socket, c);
      const attached: [string, (...args: any[]) => void][] = [];
      const on = (name: string, fn: (...args: any[]) => void) => {
        const safe = (...args: any[]) => {
          try {
            fn(...args);
          } catch {
            this.available = false;
          }
        };
        socket.on(name, safe);
        attached.push([name, safe]);
      };
      const cleanup = () => {
        for (const [name, fn] of attached) socket.removeListener(name, fn);
        this.listeners.delete(cleanup);
      };
      this.listeners.add(cleanup);
      on("lookup", (error: unknown) => {
        c.lookupAt ??= performance.now();
        if (!error) c.phase = "CONNECT";
      });
      on(
        "connectionAttempt",
        (_ip: unknown, _port: unknown, family: unknown) => {
          c.phase = "CONNECT";
          c.attempts++;
          if (family === 4 || family === 6) c.family = family;
        },
      );
      on("connect", () => {
        c.connectedAt = performance.now();
        c.phase = "TLS";
      });
      on("secureConnect", () => {
        c.secureAt = performance.now();
        c.phase = "RESPONSE";
        c.protocol = socket.alpnProtocol === "h2" ? "h2" : "h1";
      });
      on("close", cleanup);
    });
    this.subscribe(
      "undici:request:create",
      ({ request }: { request: { origin: string | URL } }) => {
        const trace = this.scope.getStore();
        if (trace && String(request.origin) === this.origin)
          this.requests.set(request, trace);
      },
    );
    this.subscribe(
      "undici:client:connected",
      ({
        socket,
        connectParams,
      }: {
        socket: Socket;
        connectParams: { version?: string };
      }) => {
        const c = this.sockets.get(socket);
        if (c && ["h1", "h2"].includes(connectParams.version ?? "")) {
          c.protocol = connectParams.version as "h1" | "h2";
          c.phase = "RESPONSE";
        }
      },
    );
    this.subscribe(
      "undici:client:sendHeaders",
      ({ request, socket }: { request: object; socket: Socket }) => {
        const t = this.requests.get(request);
        if (!t) return;
        t.connection = this.sockets.get(socket);
        if (t.connection) t.reused = t.connection.sent++ > 0;
        t.sentAt = performance.now();
        t.phase = "RESPONSE";
      },
    );
    this.subscribe(
      "undici:request:bodySent",
      ({ request }: { request: object }) => {
        const t = this.requests.get(request);
        if (t) t.bodySentAt = performance.now();
      },
    );
    this.subscribe(
      "undici:request:headers",
      ({ request }: { request: object }) => {
        const t = this.requests.get(request);
        if (t) {
          t.headersAt = performance.now();
          t.phase = "BODY";
        }
      },
    );
  }
  private subscribe<T>(name: string, fn: (value: T) => void) {
    const c = channel(name);
    const listener = (value: unknown) => {
      if (this.closed) return;
      try {
        fn(value as T);
      } catch {
        this.available = false;
      }
    };
    c.subscribe(listener);
    this.subscriptions.push(() => c.unsubscribe(listener));
  }
  trace(): NetworkTrace {
    return { began: performance.now(), phase: "UNKNOWN" };
  }
  run<T>(trace: NetworkTrace, fn: () => Promise<T>) {
    return this.scope.run(trace, fn);
  }
  snapshot(t: NetworkTrace): NetworkObservation {
    const c = t.connection,
      now = performance.now();
    const result: NetworkObservation = {
      phase: t.phase === "UNKNOWN" ? (c?.phase ?? "UNKNOWN") : t.phase,
      totalMs: Math.max(0, Math.round(now - t.began)),
      available: this.available && !this.closed,
    };
    if (c) {
      result.connectionId = c.id;
      result.protocol = c.protocol;
      result.family = c.family;
      result.reusedConnection =
        t.reused ?? (c.began >= t.began ? false : undefined);
      result.tcpAttempts = result.reusedConnection === true ? 0 : c.attempts;
      // Only attribute establishment timings to a positively identified new socket.
      if (t.reused === false || (t.reused == null && c.began >= t.began)) {
        if (c.lookupAt != null)
          result.dnsMs = Math.max(0, Math.round(c.lookupAt - c.began));
        if (c.connectedAt != null)
          result.tcpMs = Math.max(
            0,
            Math.round(c.connectedAt - (c.lookupAt ?? c.began)),
          );
        if (c.secureAt != null && c.connectedAt != null)
          result.tlsMs = Math.max(0, Math.round(c.secureAt - c.connectedAt));
      }
    }
    if (t.headersAt != null) {
      result.headersMs = Math.max(0, Math.round(t.headersAt - t.began));
      if (t.bodySentAt != null || t.sentAt != null)
        result.responseWaitMs = Math.max(
          0,
          Math.round(t.headersAt - (t.bodySentAt ?? t.sentAt!)),
        );
      result.bodyMs = Math.max(0, Math.round(now - t.headersAt));
    }
    const phaseStart =
      result.phase === "DNS"
        ? c?.began
        : result.phase === "CONNECT"
          ? c?.lookupAt
          : result.phase === "TLS"
            ? c?.connectedAt
            : result.phase === "RESPONSE"
              ? (t.bodySentAt ?? t.sentAt)
              : result.phase === "BODY"
                ? t.headersAt
                : undefined;
    if (phaseStart != null)
      result.phaseElapsedMs = Math.max(0, Math.round(now - phaseStart));
    return result;
  }
  /** Preserve safe phase evidence for apiFetch's existing classifier. */
  failure(error: unknown, trace: NetworkTrace) {
    const snapshot = this.snapshot(trace);
    const phase = ["DNS", "CONNECT", "TLS", "BODY"].includes(snapshot.phase)
      ? snapshot.phase
      : "HEADERS_OR_CONNECT";
    return Object.assign(new Error("SUI_TRANSPORT_FAILED", { cause: error }), {
      name:
        error instanceof Error &&
        ["TimeoutError", "AbortError"].includes(error.name)
          ? error.name
          : "Error",
      requestPhase: phase,
      transportTimings: Object.fromEntries(
        Object.entries(snapshot).filter(
          ([key, value]) =>
            [
              "dnsMs",
              "tcpMs",
              "tlsMs",
              "headersMs",
              "totalMs",
              "reusedConnection",
            ].includes(key) && value !== undefined,
        ),
      ),
    });
  }
  close() {
    this.closed = true;
    for (const off of this.subscriptions) off();
    this.subscriptions = [];
    for (const off of this.listeners) off();
    this.scope.disable();
  }
}
