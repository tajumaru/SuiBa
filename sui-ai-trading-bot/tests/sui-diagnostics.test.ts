import { afterEach, expect, it, vi } from "vitest";
import { channel } from "node:diagnostics_channel";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { once } from "node:events";
import { PassiveSuiDiagnostics } from "../packages/sui-client/src/diagnostics.ts";
const observers: PassiveSuiDiagnostics[] = [];
afterEach(() => {
  observers.splice(0).forEach((o) => o.close());
  vi.restoreAllMocks();
});
function observer(origin = "https://sui-fixture.invalid") {
  const d = new PassiveSuiDiagnostics(origin);
  observers.push(d);
  return d;
}
it("separates DNS/TCP/TLS/header/body timings and excludes establishment times on reuse", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const d = observer(),
    t = d.trace(),
    socket = new EventEmitter(),
    request = { origin: "https://sui-fixture.invalid" };
  await d.run(t, async () => {
    channel("undici:client:beforeConnect").publish({
      connectParams: {
        hostname: "sui-fixture.invalid",
        port: 443,
        protocol: "https:",
      },
    });
    channel("net.client.socket").publish({ socket });
    channel("undici:request:create").publish({ request });
    now = 2;
    socket.emit("lookup", null);
    socket.emit("connectionAttempt", "not-recorded", 443, 4);
    now = 5;
    socket.emit("connect");
    now = 9;
    socket.emit("secureConnect");
    now = 10;
    channel("undici:client:sendHeaders").publish({ request, socket });
    now = 11;
    channel("undici:request:bodySent").publish({ request });
    now = 20;
    channel("undici:request:headers").publish({ request });
  });
  now = 25;
  expect(d.snapshot(t)).toMatchObject({
    phase: "BODY",
    dnsMs: 2,
    tcpMs: 3,
    tlsMs: 4,
    headersMs: 20,
    responseWaitMs: 9,
    bodyMs: 5,
    reusedConnection: false,
    tcpAttempts: 1,
    family: 4,
  });
  now = 100;
  const reused = d.trace(),
    req2 = { origin: request.origin };
  await d.run(reused, async () => {
    channel("undici:request:create").publish({ request: req2 });
    channel("undici:client:sendHeaders").publish({ request: req2, socket });
  });
  const result = d.snapshot(reused);
  expect(result.reusedConnection).toBe(true);
  expect(result.connectionId).toBe(d.snapshot(t).connectionId);
  expect(result.dnsMs).toBeUndefined();
  expect(result.tcpMs).toBeUndefined();
  expect(result.tlsMs).toBeUndefined();
  expect(result.tcpAttempts).toBe(0);
});
it.each(["DNS", "CONNECT", "TLS", "RESPONSE"] as const)(
  "preserves evidence of an interrupted %s phase",
  async (phase) => {
    const d = observer(),
      t = d.trace(),
      socket = new EventEmitter(),
      request = { origin: "https://sui-fixture.invalid" };
    await d.run(t, async () => {
      channel("undici:client:beforeConnect").publish({
        connectParams: {
          hostname: "sui-fixture.invalid",
          port: 443,
          protocol: "https:",
        },
      });
      channel("net.client.socket").publish({ socket });
      if (phase !== "DNS") socket.emit("lookup", null);
      if (phase === "TLS" || phase === "RESPONSE") socket.emit("connect");
      if (phase === "RESPONSE") {
        socket.emit("secureConnect");
        channel("undici:request:create").publish({ request });
        channel("undici:client:sendHeaders").publish({ request, socket });
      }
    });
    expect(d.snapshot(t).phase).toBe(phase);
    const failure = d.failure(Error("private"), t);
    expect(failure.requestPhase).toBe(
      phase === "RESPONSE" ? "HEADERS_OR_CONNECT" : phase,
    );
    expect(JSON.stringify(failure)).not.toContain("private");
  },
);
it("does not invent zero-duration phases for unknown or foreign requests and detaches listeners", async () => {
  const d = observer(),
    t = d.trace(),
    socket = new EventEmitter();
  await d.run(t, async () => {
    channel("net.client.socket").publish({ socket });
    const request = { origin: "https://other.invalid/private?token=secret" };
    channel("undici:request:create").publish({ request });
    channel("undici:client:sendHeaders").publish({ request, socket });
  });
  expect(d.snapshot(t).phase).toBe("UNKNOWN");
  expect(d.snapshot(t).reusedConnection).toBeUndefined();
  expect(d.snapshot(t).dnsMs).toBeUndefined();
  expect(JSON.stringify(d.snapshot(t))).not.toContain("secret");
  d.close();
  expect(socket.eventNames()).toHaveLength(0);
  expect(d.snapshot(t).available).toBe(false);
});
it("preserves timeout and abort identity without exposing private messages", () => {
  const d = observer();
  for (const name of ["TimeoutError", "AbortError"]) {
    const error = Object.assign(new Error("private"), { name });
    const failure = d.failure(error, d.trace());
    expect(failure.name).toBe(name);
    expect(failure.message).toBe("SUI_TRANSPORT_FAILED");
    expect(JSON.stringify(failure)).not.toContain("private");
  }
});
it("observes actual loopback fetch without adding network calls or altering the dispatcher", async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.end("fixture");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number },
    origin = `http://localhost:${address.port}`,
    d = observer(origin);
  try {
    const traces = [];
    for (let n = 0; n < 3; n++) {
      const trace = d.trace();
      await d.run(trace, async () => {
        const response = await fetch(origin);
        await response.text();
      });
      traces.push(d.snapshot(trace));
      await new Promise(setImmediate);
    }
    expect(requests).toBe(3);
    expect(traces.every((t) => t.protocol === "h1" && t.phase === "BODY")).toBe(
      true,
    );
    expect(traces.some((t) => t.reusedConnection === true)).toBe(true);
    expect(
      traces
        .filter((t) => t.reusedConnection)
        .every((t) => t.dnsMs === undefined),
    ).toBe(true);
  } finally {
    d.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
