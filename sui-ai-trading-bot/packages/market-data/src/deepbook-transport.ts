import {
  connect,
  type ClientHttp2Session,
  type ClientHttp2Stream,
  constants,
} from "node:http2";
import type { RequestPhase } from "../../shared/src/http-errors.ts";
const origin = "https://deepbook-indexer.mainnet.mystenlabs.com";
type Connection = {
  session: ClientHttp2Session;
  phase: RequestPhase;
  began: number;
  active: number;
  dnsMs?: number;
  tcpMs?: number;
  tlsMs?: number;
};
/** Public, read-only DeepBook traffic only. ApiAccess remains responsible for limits/retries/safety. */
export class DeepBookTransport {
  private connection: Connection | null = null;
  constructor(
    private authority = origin,
    private open: (origin: string) => ClientHttp2Session = (origin) =>
      connect(origin, { settings: { enablePush: false } }),
  ) {}
  close() {
    this.connection?.session.destroy();
    this.connection = null;
  }
  private acquire() {
    const previous = this.connection;
    if (previous && !previous.session.closed && !previous.session.destroyed)
      return { connection: previous, reused: true };
    const c: Connection = {
      session: this.open(this.authority),
      phase: "DNS",
      began: performance.now(),
      active: 0,
    };
    this.connection = c;
    const elapsed = () => Math.round(performance.now() - c.began);
    c.session.socket.once("lookup", () => {
      c.dnsMs = elapsed();
      c.phase = "CONNECT";
    });
    c.session.socket.once("connect", () => {
      c.tcpMs = elapsed();
      c.phase = "TLS";
    });
    c.session.once("connect", () => {
      c.tlsMs = elapsed();
      c.phase = "HEADERS_OR_CONNECT";
    });
    c.session.on("error", () => {}); // Stream errors reject their own request; never log raw server/error text.
    c.session.on("stream", (s) => {
      s.on("error", () => {});
      s.close(constants.NGHTTP2_REFUSED_STREAM);
    });
    c.session.once("goaway", () => {
      if (this.connection === c) this.connection = null;
      c.session.close();
    });
    c.session.once("close", () => {
      if (this.connection === c) this.connection = null;
    });
    c.session.setTimeout(120000, () => c.session.close());

    return { connection: c, reused: false };
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    if (
      url.origin !== this.authority ||
      method !== "GET" ||
      url.username ||
      url.password
    )
      throw Error("DEEPBOOK_READ_ONLY_TRANSPORT");
    const signal = AbortSignal.any([
      AbortSignal.timeout(8000),
      ...(init?.signal ? [init.signal] : []),
      ...(input instanceof Request ? [input.signal] : []),
    ]);
    signal.throwIfAborted();
    const began = performance.now(),
      { connection: c, reused } = this.acquire();
    c.active++;
    c.session.ref();
    let phase: RequestPhase = "HEADERS_OR_CONNECT";
    const timings: Record<string, number | boolean> = {
      reusedConnection: reused,
    };
    return new Promise<Response>((resolve, reject) => {
      let stream: ClientHttp2Stream | undefined,
        done = false,
        status = 0,
        bytes = 0;
      const chunks: Buffer[] = [],
        headers = new Headers();
      const fail = (error: unknown) => {
        if (done) return;
        done = true;
        signal.removeEventListener("abort", abort);
        const actual = c.tlsMs == null ? c.phase : phase;
        if (!reused)
          for (const key of ["dnsMs", "tcpMs", "tlsMs"] as const)
            if (c[key] != null) timings[key] = c[key]!;
        const failure = Object.assign(
          new Error("UPSTREAM_TRANSPORT_FAILED", { cause: error }),
          {
            name:
              error &&
              typeof error === "object" &&
              "name" in error &&
              ["TimeoutError", "AbortError"].includes(String(error.name))
                ? String(error.name)
                : "Error",
            requestPhase: actual,
            transportTimings: {
              ...timings,
              totalMs: Math.round(performance.now() - began),
            },
          },
        );
        stream?.close(constants.NGHTTP2_CANCEL);
        // An aborted connect must not continue as an orphaned socket past the request deadline.
        c.active--;
        c.session.destroy();
        if (this.connection === c) this.connection = null;
        reject(failure);
      };
      const succeed = (body: Buffer | null) => {
        try {
          const response = new Response(
            [204, 205, 304].includes(status) || !body
              ? null
              : Uint8Array.from(body),
            { status, headers },
          );
          done = true;
          signal.removeEventListener("abort", abort);
          c.active--;
          if (c.active === 0 && !c.session.destroyed) c.session.unref();
          resolve(response);
        } catch (e) {
          fail(e);
        }
      };
      const abort = () => fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        stream = c.session.request(
          {
            ":method": "GET",
            ":path": url.pathname + url.search,
            accept: "application/json",
            "accept-encoding": "identity",
          },
          { endStream: true },
        );
        stream.on("response", (h) => {
          status = Number(h[":status"]);
          phase = "BODY";
          timings.headersMs = Math.round(performance.now() - began);
          for (const [key, value] of Object.entries(h))
            if (!key.startsWith(":") && value != null)
              headers.set(
                key,
                Array.isArray(value) ? value.join(", ") : String(value),
              );
          // Surface HTTP failures immediately: a hanging error body must never postpone 429 safety handling.
          if (status >= 300) {
            succeed(null);
            stream!.close(constants.NGHTTP2_CANCEL);
          }
        });
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) fail(Error("RESPONSE_LIMIT"));
          else chunks.push(chunk);
        });
        stream.once("error", fail);
        stream.once("aborted", () => fail(Error("STREAM_ABORTED")));
        stream.once("end", () => {
          if (done) return;
          if (!status || stream!.rstCode !== constants.NGHTTP2_NO_ERROR) {
            fail(Error("INCOMPLETE_RESPONSE"));
            return;
          }
          succeed(Buffer.concat(chunks));
        });
        stream.once("close", () => {
          if (!done) fail(Error("STREAM_CLOSED"));
        });
        if (signal.aborted) abort();
      } catch (e) {
        fail(e);
      }
    });
  };
}
export const deepBookTransport = new DeepBookTransport();
