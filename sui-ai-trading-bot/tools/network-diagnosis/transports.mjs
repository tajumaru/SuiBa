import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { connect as h2connect, constants } from "node:http2";
import {
  LIMITS,
  SUI,
  DEEP,
  COIN,
  BOOK_PATH,
  guardRequest,
  safeCode,
  times,
} from "./core.mjs";

export class TraceObserver {
  scope = new AsyncLocalStorage();
  sockets = new WeakMap();
  requests = new WeakMap();
  serial = 0;
  subscriptions = [];
  cleanups = new Set();
  constructor() {
    const sub = (name, fn) => {
      const c = channel(name),
        listener = (value) => {
          try {
            fn(value);
          } catch {
            const t = this.scope.getStore();
            if (t) t.observerFault = true;
          }
        };
      c.subscribe(listener);
      this.subscriptions.push(() => c.unsubscribe(listener));
    };
    sub("undici:client:beforeConnect", ({ connectParams: p }) => {
      const t = this.scope.getStore();
      if (t) t.expectSocket = p.hostname === new URL(t.origin).hostname;
    });
    sub("net.client.socket", ({ socket }) => {
      const t = this.scope.getStore();
      if (!t?.expectSocket || this.sockets.has(socket)) return;
      t.expectSocket = false;
      const c = { id: ++this.serial, began: performance.now(), uses: 0 };
      t.connection = c;
      t.reused = false;
      this.sockets.set(socket, c);
      const attached = [];
      const on = (event, fn) => {
        socket.on(event, fn);
        attached.push([event, fn]);
      };
      on("lookup", (error) => {
        c.dnsAt = performance.now();
        c.dnsError = !!error;
      });
      on("connect", () => {
        c.tcpAt = performance.now();
        c.family = socket.remoteFamily;
        c.peerAddress = socket.remoteAddress;
        c.localPort = socket.localPort;
      });
      on("secureConnect", () => {
        c.tlsAt = performance.now();
        c.protocol = socket.alpnProtocol || "http/1.1";
      });
      const cleanup = () => {
        for (const [e, f] of attached) socket.removeListener(e, f);
        this.cleanups.delete(cleanup);
      };
      on("close", cleanup);
      this.cleanups.add(cleanup);
    });
    sub("undici:request:create", ({ request }) => {
      const t = this.scope.getStore();
      if (t && String(request.origin) === t.origin)
        this.requests.set(request, t);
    });
    sub("undici:client:sendHeaders", ({ request, socket }) => {
      const t = this.requests.get(request);
      if (!t) return;
      const c = this.sockets.get(socket);
      if (c) {
        t.connection = c;
        t.reused = c.uses++ > 0;
      }
      t.dispatchAt = performance.now();
    });
    sub("undici:request:bodySent", ({ request }) => {
      const t = this.requests.get(request);
      if (t) {
        t.sentAt = performance.now();
        t.sentBasis = "undici-request-bodySent";
      }
    });
    sub("undici:request:headers", ({ request }) => {
      const t = this.requests.get(request);
      if (t) t.headersAt = performance.now();
    });
  }
  trace(profile) {
    return {
      began: performance.now(),
      origin: profile.target === "sui" ? SUI : DEEP,
      calls: 0,
    };
  }
  run(trace, fn) {
    return this.scope.run(trace, fn);
  }
  close() {
    for (const f of this.subscriptions) f();
    for (const f of [...this.cleanups]) f();
    this.scope.disable();
  }
}

// Buffer only one bounded response, so body receipt timing is independent of SDK parsing.
export async function buffered(response, trace, signal) {
  trace.status = response.status;
  trace.headersAt ??= performance.now();
  signal.throwIfAborted();
  if (response.status === 429) {
    await response.body?.cancel();
    throw Error("RATE_LIMITED");
  }
  const reader = response.body?.getReader(),
    chunks = [];
  let bytes = 0;
  try {
    if (reader)
      while (true) {
        const r = await reader.read();
        signal.throwIfAborted();
        if (r.done) break;
        bytes += r.value.byteLength;
        if (bytes > LIMITS.maxBodyBytes) throw Error("RESPONSE_LIMIT");
        chunks.push(r.value);
      }
  } catch (e) {
    await reader?.cancel().catch(() => {});
    throw e;
  } finally {
    reader?.releaseLock();
  }
  trace.bodyEnd ??= performance.now();
  trace.bytes = bytes;
  return new Response(bytes ? Buffer.concat(chunks) : null, {
    status: response.status,
    headers: response.headers,
  });
}

export function h2Transport(profile, observer, open = h2connect) {
  let connection = null;
  const close = () => {
    connection?.session.destroy();
    connection = null;
  };
  return {
    close,
    fetch: async (input, init, trace) => {
      const url = guardRequest(profile, input, init),
        signal = init.signal;
      signal.throwIfAborted();
      if (
        !connection ||
        connection.session.closed ||
        connection.session.destroyed
      ) {
        const session = open(url.origin, {
          settings: { enablePush: false },
          ...(profile.family ? { family: profile.family } : {}),
        });
        const c = {
          id: ++observer.serial,
          began: performance.now(),
          session,
          uses: 0,
        };
        connection = c;
        session.on("error", () => {});
        session.socket.once("lookup", (error) => {
          c.dnsAt = performance.now();
          c.dnsError = !!error;
        });
        session.socket.once("connect", () => {
          c.tcpAt = performance.now();
          c.family = session.socket.remoteFamily;
          c.peerAddress = session.socket.remoteAddress;
          c.localPort = session.socket.localPort;
        });
        session.once("connect", () => {
          c.tlsAt = performance.now();
          c.protocol = session.alpnProtocol;
        });
        session.once("goaway", () => {
          if (connection === c) connection = null;
          session.close();
        });
        session.once("close", () => {
          if (connection === c) connection = null;
        });
      }
      const c = connection;
      trace.connection = c;
      trace.reused = c.uses++ > 0;
      return new Promise((resolve, reject) => {
        let stream,
          done = false;
        const finish = (error, value) => {
          if (done) return;
          done = true;
          signal.removeEventListener("abort", abort);
          if (error) {
            stream?.close(constants.NGHTTP2_CANCEL);
            c.session.destroy();
            if (connection === c) connection = null;
            reject(error);
          } else resolve(value);
        };
        const abort = () => finish(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        try {
          const headers = Object.fromEntries(new Headers(init.headers));
          delete headers.connection;
          delete headers.host;
          delete headers["transfer-encoding"];
          trace.queuedAt = performance.now();
          stream = c.session.request({
            ":method": init.method ?? "GET",
            ":path": url.pathname + url.search,
            ...headers,
          });
          let bytes = 0,
            status = null,
            responseHeaders = {},
            chunks = [];
          const markSent = () => {
            if (trace.readyAt != null && trace.writeFinishedAt != null) {
              trace.sentAt = Math.max(trace.readyAt, trace.writeFinishedAt);
              trace.sentBasis = `http2-stream-ready-and-${trace.writeFinishObservation}`;
            }
          };
          const ready = () => {
            trace.readyAt ??= performance.now();
            markSent();
          };
          // A connected session may assign the stream ID synchronously in request().
          if (Number.isInteger(stream.id) && stream.id > 0) ready();
          else stream.once("ready", ready);
          const writeFinished = (observation) => {
            trace.writeFinishedAt ??= performance.now();
            trace.writeFinishObservation ??= observation;
            markSent();
          };
          stream.once("finish", () => writeFinished("write-finish-event"));
          if (stream.writableFinished) writeFinished("write-finish-state");
          stream.on("response", (h) => {
            trace.headersAt = performance.now();
            status = Number(h[":status"]);
            trace.status = status;
            for (const [k, v] of Object.entries(h))
              if (!k.startsWith(":") && v != null)
                responseHeaders[k] = Array.isArray(v)
                  ? v.join(", ")
                  : String(v);
            if (status === 429) finish(Error("RATE_LIMITED"));
          });
          stream.on("data", (b) => {
            if (done) return;
            bytes += b.length;
            if (bytes > LIMITS.maxBodyBytes) finish(Error("RESPONSE_LIMIT"));
            else chunks.push(b);
          });
          stream.once("error", (e) => finish(e));
          stream.once("aborted", () => finish(Error("INCOMPLETE_BODY")));
          stream.once("end", () => {
            if (done) return;
            if (!status || stream.rstCode !== constants.NGHTTP2_NO_ERROR)
              return finish(Error("INCOMPLETE_BODY"));
            trace.bodyEnd ??= performance.now();
            trace.bytes = bytes;
            try {
              finish(
                null,
                new Response(bytes ? Buffer.concat(chunks) : null, {
                  status,
                  headers: responseHeaders,
                }),
              );
            } catch (e) {
              finish(e);
            }
          });
          stream.once("close", () => {
            if (!done) finish(Error("INCOMPLETE_BODY"));
          });
          stream.end(init.body ?? undefined);
          if (signal.aborted) abort();
        } catch (e) {
          finish(e);
        }
      });
    },
  };
}

export async function sdkClient(fetchImpl) {
  const { SuiGrpcClient, GrpcWebFetchTransport } =
    await import("@mysten/sui/grpc");
  return new SuiGrpcClient({
    network: "mainnet",
    transport: new GrpcWebFetchTransport({ baseUrl: SUI, fetch: fetchImpl }),
  });
}
export async function metadata(client, signal) {
  const { coinMetadata: m } = await client.getCoinMetadata({
    coinType: COIN,
    signal,
  });
  signal.throwIfAborted();
  if (!m || m.decimals !== 9 || m.symbol !== "SUI")
    throw Error("INVALID_METADATA");
}

export const CONTROLLED_POOL = Object.freeze({
  name: "diagnostic-15s-idle",
  keepAliveTimeout: 15000,
  keepAliveMaxTimeout: 15000,
  keepAliveTimeoutThreshold: 1000,
  serverMayShorten: true,
});
export function controlledAgentOptions(profile) {
  return {
    connections: 1,
    pipelining: 1,
    allowH2: false,
    keepAliveTimeout: CONTROLLED_POOL.keepAliveTimeout,
    keepAliveMaxTimeout: CONTROLLED_POOL.keepAliveMaxTimeout,
    keepAliveTimeoutThreshold: CONTROLLED_POOL.keepAliveTimeoutThreshold,
    connect: { ...(profile.family ? { family: profile.family } : {}) },
  };
}

export async function createHarness() {
  const [{ Agent }] = await Promise.all([
    import("undici"),
    import("@mysten/sui/grpc"),
  ]);
  const observer = new TraceObserver();
  const warm = new Map();
  const previousEnds = new Map();
  const make = (profile) =>
    profile.protocol === "h2"
      ? h2Transport(profile, observer)
      : profile.protocol === "default-fetch"
        ? { close: async () => {}, fetch: (input, init) => fetch(input, init) }
        : (() => {
            const agent = new Agent(controlledAgentOptions(profile));
            return {
              close: () => agent.destroy(),
              fetch: (input, init) =>
                fetch(input, { ...init, dispatcher: agent }),
            };
          })();
  return {
    async attempt(profile, mode, cycleSignal) {
      const key = JSON.stringify(profile);
      let transport;
      if (mode === "cold") transport = make(profile);
      else {
        if (!warm.has(key)) warm.set(key, make(profile));
        transport = warm.get(key);
      }
      const gapSincePreviousAttemptMs = previousEnds.has(key)
        ? performance.now() - previousEnds.get(key)
        : null;
      const trace = observer.trace(profile),
        startedAt = Date.now();
      const signal = AbortSignal.any([
        cycleSignal,
        AbortSignal.timeout(
          profile.target === "sui" ? LIMITS.suiMs : LIMITS.deepbookMs,
        ),
      ]);
      let code = null,
        endedAt,
        finished;
      try {
        await observer.run(trace, async () => {
          const request = async (input, init = {}) => {
            guardRequest(profile, input, init);
            if (++trace.calls !== 1) throw Error("UNEXPECTED_RPC_COUNT");
            try {
              const response = await transport.fetch(
                input,
                { ...init, signal },
                trace,
              );
              return await buffered(response, trace, signal);
            } catch (e) {
              trace.transportCode = safeCode(e);
              throw e;
            }
          };
          if (profile.target === "sui")
            await metadata(await sdkClient(request), signal);
          else {
            const response = await request(DEEP + BOOK_PATH, {
              method: "GET",
              headers: { accept: "application/json" },
            });
            const body = await response.json();
            if (
              !response.ok ||
              !Number.isFinite(Number(body.timestamp)) ||
              !body.bids?.length ||
              !body.asks?.length
            )
              throw Error("INVALID_ORDERBOOK");
          }
          signal.throwIfAborted();
          if (trace.calls !== 1) throw Error("UNEXPECTED_RPC_COUNT");
        });
      } catch (e) {
        code = signal.aborted
          ? safeCode(signal.reason)
          : (trace.transportCode ?? safeCode(e));
      } finally {
        finished = performance.now();
        endedAt = Date.now();
        previousEnds.set(key, finished);
        if (
          finished - trace.began >
          (profile.target === "sui" ? LIMITS.suiMs : LIMITS.deepbookMs)
        )
          code = "REQUEST_TIMEOUT";
        if (mode === "cold" || code) {
          await transport.close();
          if (mode !== "cold") warm.delete(key);
        }
      }
      return {
        kind: "attempt",
        profile: { ...profile },
        mode,
        poolPolicy: profile.protocol === "fetch" ? CONTROLLED_POOL : null,
        gapSincePreviousAttemptMs,
        startedAt,
        endedAt,
        success: code === null,
        code,
        httpStatus: trace.status ?? null,
        wireRequests: trace.calls,
        bytes: trace.bytes ?? null,
        observerFault: trace.observerFault ?? false,
        timing: times(trace, finished),
      };
    },
    async close() {
      for (const t of warm.values()) await t.close();
      warm.clear();
      observer.close();
    },
  };
}
