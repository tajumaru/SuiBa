import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import {
  createServer,
  connect,
  type Http2Server,
  type ServerHttp2Stream,
} from "node:http2";
import { DeepBookTransport } from "../packages/market-data/src/deepbook-transport.ts";
import { apiFetch, apiAccess } from "../packages/shared/src/api.ts";
import {
  classifyHttpFailure,
  transportDiagnostics,
} from "../packages/shared/src/http-errors.ts";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
async function fixture() {
  let connections = 0,
    requests = 0;
  const server = createServer();
  server.on("session", () => connections++);
  let handler = (s: ServerHttp2Stream) => {
    s.respond({ ":status": 200, "content-type": "application/json" });
    s.end('{"ok":true}');
  };
  server.on("stream", (s) => {
    requests++;
    s.on("error", () => {});
    handler(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const transport = new DeepBookTransport(origin);
  cleanups.push(
    () => new Promise<void>((r) => server.close(() => r())),
    () => transport.close(),
  );
  return {
    transport,
    origin,
    server,
    connections: () => connections,
    requests: () => requests,
    handle: (f: typeof handler) => (handler = f),
  };
}
it("reuses a single connection across requests and preserves JSON", async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++)
    expect(
      await (await f.transport.fetch(f.origin + "/status")).json(),
    ).toEqual({ ok: true });
  expect(f.connections()).toBe(1);
  expect(f.requests()).toBe(3);
  f.transport.close();
  await f.transport.fetch(f.origin + "/status");
  expect(f.connections()).toBe(2);
});
it.each([404, 429, 500, 502, 503, 504])(
  "returns HTTP %i at headers without waiting for the error body",
  async (status) => {
    const f = await fixture();
    f.handle((s) => {
      s.respond({ ":status": status, "retry-after": "120" });
      s.write("unfinished error");
    });
    const r = await f.transport.fetch(f.origin + "/status", {
      signal: AbortSignal.timeout(2000),
    });
    expect(r.status).toBe(status);
    expect(r.headers.get("retry-after")).toBe("120");
  },
);
it.each(["headers", "body"] as const)(
  "times out %s, destroys the connection and never returns partial data",
  async (where) => {
    const f = await fixture();
    f.handle((s) => {
      if (where === "body") {
        s.respond({ ":status": 200 });
        s.write('{"partial":');
      }
    });
    const signal = AbortSignal.timeout(80);
    const error = await f.transport
      .fetch(f.origin + "/status", { signal })
      .catch((e) => e);
    expect(transportDiagnostics(error).phase).toBe(
      where === "body" ? "BODY" : "HEADERS_OR_CONNECT",
    );
    expect(
      classifyHttpFailure(error, transportDiagnostics(error).phase!, signal)
        .code,
    ).toBe(where === "body" ? "UPSTREAM_BODY_TIMEOUT" : "UPSTREAM_TIMEOUT");
    f.handle((s) => {
      s.respond({ ":status": 200 });
      s.end("{}");
    });
    expect((await f.transport.fetch(f.origin + "/status")).status).toBe(200);
    expect(f.connections()).toBe(2);
  },
);
it("abort cancels a pending response immediately", async () => {
  const f = await fixture();
  f.handle(() => {});
  const c = new AbortController();
  const request = f.transport.fetch(f.origin + "/status", { signal: c.signal });
  c.abort();
  const e = await request.catch((e) => e);
  expect(classifyHttpFailure(e, "HEADERS_OR_CONNECT", c.signal).code).toBe(
    "API_CANCELLED",
  );
});
it("refuses writes, different hosts and URL credentials without connecting", async () => {
  const f = await fixture();
  for (const [url, init] of [
    [f.origin, { method: "POST" }],
    ["https://example.com", {}],
    [f.origin.replace("://", "://secret@"), {}],
  ] as const)
    await expect(f.transport.fetch(url, init)).rejects.toThrow(
      "DEEPBOOK_READ_ONLY_TRANSPORT",
    );
  expect(f.requests()).toBe(0);
});
it("goaway retires the connection and the next read creates one new connection", async () => {
  const f = await fixture();
  let sent = false;
  f.handle((s) => {
    s.respond({ ":status": 200 });
    s.end("{}");
    if (!sent) {
      sent = true;
      s.session!.goaway();
    }
  });
  await f.transport.fetch(f.origin + "/status");
  await new Promise((r) => setTimeout(r, 25));
  await f.transport.fetch(f.origin + "/status");
  expect(f.connections()).toBe(2);
});
it.each(["DNS", "CONNECT", "TLS"] as const)(
  "deadline during %s destroys the connecting session",
  async (phase) => {
    const socket = new EventEmitter(),
      stream = Object.assign(new EventEmitter(), {
        close: () => stream.emit("close"),
      });
    const session = Object.assign(new EventEmitter(), {
      socket,
      connecting: true,
      closed: false,
      destroyed: false,
      request: () => stream,
      ref: () => {},
      unref: () => {},
      setTimeout: () => {},
      destroy: () => {
        session.destroyed = true;
        session.emit("close");
      },
    });
    const transport = new DeepBookTransport(
      "https://deepbook-indexer.mainnet.mystenlabs.com",
      () => session as unknown as ReturnType<typeof connect>,
    );
    const controller = new AbortController();
    const request = transport.fetch(
      "https://deepbook-indexer.mainnet.mystenlabs.com/status",
      { signal: controller.signal },
    );
    if (phase !== "DNS") socket.emit("lookup");
    if (phase === "TLS") socket.emit("connect");
    controller.abort(new DOMException("deadline", "TimeoutError"));
    const e = await request.catch((e) => e);
    expect(transportDiagnostics(e).phase).toBe(phase);
    expect(session.destroyed).toBe(true);
    expect(classifyHttpFailure(e, phase, controller.signal).code).toBe(
      phase === "CONNECT" ? "UPSTREAM_CONNECT_TIMEOUT" : "UPSTREAM_TIMEOUT",
    );
  },
);
it("logging accepts only whitelisted phases, booleans and finite timings", () => {
  expect(
    transportDiagnostics({
      requestPhase: "secret",
      transportTimings: {
        token: "secret",
        dnsMs: NaN,
        tcpMs: -1,
        totalMs: 8,
        reusedConnection: true,
      },
    }),
  ).toEqual({
    phase: undefined,
    timings: { totalMs: 8, reusedConnection: true },
  });
});
it("API instrumentation preserves BODY timeouts from the buffered transport", async () => {
  const f = await fixture();
  f.handle((s) => {
    s.respond({ ":status": 200 });
    s.write("partial");
  });
  await expect(
    apiFetch(
      "DeepBook transport test",
      f.origin + "/status",
      { signal: AbortSignal.timeout(80) },
      0,
      { transport: f.transport.fetch },
    ),
  ).rejects.toThrow("UPSTREAM_BODY_TIMEOUT");
  expect(
    apiAccess.snapshot().find((s) => s.api === "DeepBook transport test")!
      .lastFailure,
  ).toMatchObject({
    phase: "BODY",
    transportTimings: { reusedConnection: false },
  });
});
it("429 stops immediately without waiting for a hanging body or hiding the limit", async () => {
  const f = await fixture();
  f.handle((s) => {
    s.respond({ ":status": 429, "retry-after": "120" });
    s.write("partial");
  });
  let stops = 0;
  apiAccess.onRateLimit = () => {
    stops++;
  };
  try {
    await expect(
      apiFetch("h2 429", f.origin + "/status", undefined, 0, {
        transport: f.transport.fetch,
        maxTransientRetries: 2,
      }),
    ).rejects.toThrow("API_RETRIES_EXHAUSTED");
    expect(stops).toBe(1);
    expect(f.requests()).toBe(1);
  } finally {
    apiAccess.onRateLimit = () => {};
  }
});
it("transient failures stop before bounded retries and recovery never restarts a bot", async () => {
  const f = await fixture();
  let running = true,
    failures = 0;
  f.handle((s) => {
    s.respond({ ":status": 503 });
    s.end();
  });
  apiAccess.onTransientFailure = () => {
    if (!failures) expect(f.requests()).toBe(1);
    running = false;
    failures++;
  };
  try {
    await expect(
      apiFetch("h2 transient", f.origin + "/status", undefined, 0, {
        transport: f.transport.fetch,
        maxTransientRetries: 2,
      }),
    ).rejects.toThrow("UPSTREAM_HTTP_503");
    expect(failures).toBe(3);
    expect(f.requests()).toBe(3);
    expect(running).toBe(false);
    const circuit = apiAccess.snapshot().find((a) => a.api === "h2 transient")!;
    expect(circuit.circuit).toBe("OPEN");
    expect(apiAccess.blocked()).toBe(true);
    f.handle((s) => {
      s.respond({ ":status": 200 });
      s.end("{}");
    });
    // Advance only the circuit clock; retain real HTTP/2 I/O and timeouts.
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(circuit.circuitUntil! + 1);
    try {
      await apiFetch("h2 transient", f.origin + "/status", undefined, 0, {
        transport: f.transport.fetch,
      });
    } finally {
      clock.mockRestore();
    }
    expect(running).toBe(false);
  } finally {
    apiAccess.onTransientFailure = () => {};
  }
}, 10000);
it("existing single-flight and short cache work with the reused connection", async () => {
  const f = await fixture();
  const read = () =>
    apiFetch("h2 cached", f.origin + "/status", undefined, 20, {
      transport: f.transport.fetch,
    });
  await Promise.all([read(), read()]);
  await read();
  expect(f.requests()).toBe(1);
  await new Promise((r) => setTimeout(r, 25));
  await read();
  expect(f.requests()).toBe(2);
  expect(f.connections()).toBe(1);
});

it("preserves received HTTP status when the buffered successful body times out", async () => {
  const f = await fixture();
  f.handle((s) => {
    s.respond({ ":status": 200 });
    s.write("partial");
  });
  await expect(
    apiFetch(
      "h2 body status",
      f.origin + "/status",
      { signal: AbortSignal.timeout(80) },
      0,
      { transport: f.transport.fetch },
    ),
  ).rejects.toThrow("UPSTREAM_BODY_TIMEOUT");
  expect(
    apiAccess.snapshot().find((s) => s.api === "h2 body status")?.lastFailure
      ?.status,
  ).toBe(200);
});
