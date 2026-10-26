import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import {
  classifyHttpFailure,
  requestIdentity,
} from "../packages/shared/src/http-errors.ts";
const url =
  "https://api.geckoterminal.com/api/v2/networks/sui-network/pools/0x0df4f02d0e210169cb6d5aabd03c3058328c06f2c4dbb0804faa041159c78443/ohlcv/minute?aggregate=5&limit=1000&currency=token&token=quote&include_empty_intervals=false";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function transport(fn?: typeof fetch) {
  vi.resetModules();
  if (fn) vi.stubGlobal("fetch", fn);
  return import("../packages/shared/src/api.ts");
}
it.each([
  ["ENOTFOUND", "UPSTREAM_DNS_FAILED", "DNS"],
  ["EAI_AGAIN", "UPSTREAM_DNS_FAILED", "DNS"],
  ["UND_ERR_CONNECT_TIMEOUT", "UPSTREAM_CONNECT_TIMEOUT", "CONNECT"],
  ["UND_ERR_HEADERS_TIMEOUT", "UPSTREAM_HEADERS_TIMEOUT", "HEADERS_OR_CONNECT"],
  ["UND_ERR_BODY_TIMEOUT", "UPSTREAM_BODY_TIMEOUT", "BODY"],
  ["CERT_HAS_EXPIRED", "UPSTREAM_TLS_FAILED", "TLS"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "UPSTREAM_TLS_FAILED", "TLS"],
  ["ECONNREFUSED", "UPSTREAM_NETWORK_FAILED", "HEADERS_OR_CONNECT"],
  ["ECONNRESET", "UPSTREAM_NETWORK_FAILED", "HEADERS_OR_CONNECT"],
  ["UND_ERR_SOCKET", "UPSTREAM_NETWORK_FAILED", "HEADERS_OR_CONNECT"],
])(
  "preserves %s without reporting a false timeout",
  async (causeCode, code, phase) => {
    const fetcher = vi.fn(async () => {
      throw new TypeError("secret URL and Authorization", {
        cause: Object.assign(new Error("secret"), { code: causeCode }),
      });
    });
    const { apiAccess, apiFetch } = await transport(fetcher);
    await expect(apiFetch("GeckoTerminal", url)).rejects.toThrow(code);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(apiAccess.snapshot()[1].lastFailure).toMatchObject({
      code,
      causeCode,
      phase,
      operation: "OHLCV_5M",
      host: "api.geckoterminal.com",
      status: null,
    });
    expect(JSON.stringify(apiAccess.snapshot())).not.toContain("secret");
  },
);
it.each([404, 500, 503])(
  "records HTTP %s separately and does not retry it",
  async (status) => {
    const fn = vi.fn(async () => new Response("untrusted secret", { status }));
    const { apiAccess, apiFetch } = await transport(fn);
    await expect(apiFetch("GeckoTerminal", url)).rejects.toThrow(
      `UPSTREAM_HTTP_${status}`,
    );
    expect(apiAccess.snapshot()[1].lastFailure).toMatchObject({
      status,
      phase: "HTTP",
      code: `UPSTREAM_HTTP_${status}`,
    });
    expect(fn).toHaveBeenCalledTimes(1);
  },
);
it("keeps 429 safety stop callback and bounded retry policy", async () => {
  const { apiAccess, apiFetch } = await transport(
    vi.fn(
      async () =>
        new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
    ),
  );
  const stop = vi.fn();
  apiAccess.onRateLimit = stop;
  await expect(apiFetch("GeckoTerminal", url)).rejects.toThrow(
    "API_RETRIES_EXHAUSTED",
  );
  expect(stop).toHaveBeenCalledOnce();
  expect(apiAccess.snapshot()[1]).toMatchObject({
    exhausted: true,
    requests: 1,
    rateLimits: 1,
    lastFailure: { code: "UPSTREAM_HTTP_429", status: 429, phase: "HTTP" },
  });
});
it("returns a normal Gecko response and no failure record", async () => {
  const { apiAccess, apiFetch } = await transport(
    vi.fn(async () =>
      Response.json({ data: { attributes: { ohlcv_list: [] } } }),
    ),
  );
  expect(await (await apiFetch("GeckoTerminal", url)).json()).toHaveProperty(
    "data.attributes.ohlcv_list",
  );
  expect(apiAccess.snapshot()[1]).toMatchObject({
    failed: false,
    requests: 1,
    lastFailure: null,
  });
});
it("redacts credentials, arbitrary paths, headers, query values and unknown error messages", async () => {
  const secret = "never-store-or-log-this";
  const identity = requestIdentity(
    "Sui gRPC",
    `https://user:${secret}@rpc.example/${secret}?apikey=${secret}`,
    "POST",
  );
  expect(JSON.stringify(identity)).not.toContain(secret);
  expect(identity.url).toBe("https://rpc.example/[redacted]");
  expect(
    JSON.stringify(
      requestIdentity("GeckoTerminal", url + `&apikey=${secret}`, "GET"),
    ),
  ).not.toContain(secret);
  expect(
    requestIdentity(
      "GeckoTerminal",
      url.replace("token=quote", `token=${secret}`),
      "GET",
    ).url,
  ).not.toContain(secret);
  expect(classifyHttpFailure(new Error(secret), "BODY")).toMatchObject({
    code: "UPSTREAM_NETWORK_FAILED",
    causeCode: null,
  });
});
it("preserves a caller cancellation instead of calling it a timeout", async () => {
  const controller = new AbortController();
  controller.abort();
  const fn = vi.fn<typeof fetch>(async (_, init) => {
    init!.signal!.throwIfAborted();
    throw new Error("unreachable");
  });
  const { apiFetch } = await transport(fn);
  await expect(
    apiFetch("GeckoTerminal", new Request(url, { signal: controller.signal })),
  ).rejects.toThrow("API_CANCELLED");
});
it.each([false, true])(
  "aborts the real HTTP request at the configured deadline; bodyStarted=%s",
  async (bodyStarted) => {
    let accepted = false;
    const server = createServer((_, res) => {
      accepted = true;
      if (bodyStarted) {
        res.writeHead(200);
        res.flushHeaders();
        res.write("partial");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { apiAccess, apiFetch, apiLimits } = await transport();
    apiLimits.timeoutMs = 200;
    try {
      const { port } = server.address() as { port: number };
      await expect(
        apiFetch("GeckoTerminal", `http://127.0.0.1:${port}/`),
      ).rejects.toThrow(
        bodyStarted ? "UPSTREAM_BODY_TIMEOUT" : "UPSTREAM_TIMEOUT",
      );
      expect(accepted).toBe(true);
      expect(apiAccess.snapshot()[1]).toMatchObject({
        active: false,
        requests: 1,
        lastFailure: {
          phase: bodyStarted ? "BODY" : "HEADERS_OR_CONNECT",
          status: bodyStarted ? 200 : null,
        },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

it("classifies an actual socket disconnect without retrying or using a cached value", async () => {
  const server = createServer((req) => req.socket.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { apiAccess, apiFetch } = await transport();
  try {
    const { port } = server.address() as { port: number };
    await expect(
      apiFetch("GeckoTerminal", `http://127.0.0.1:${port}/`),
    ).rejects.toThrow("UPSTREAM_NETWORK_FAILED");
    expect(apiAccess.snapshot()[1]).toMatchObject({
      requests: 1,
      retries: 0,
      failed: true,
      lastFailure: { code: "UPSTREAM_NETWORK_FAILED" },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

it("rejects an interrupted response stream without caching partial JSON (offline fixture)", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"partial":'));
            queueMicrotask(() =>
              stream.error(
                new TypeError("terminated", {
                  cause: Object.assign(new Error("socket closed"), {
                    code: "UND_ERR_SOCKET",
                  }),
                }),
              ),
            );
          },
        }),
        { status: 200 },
      ),
  );
  const { apiAccess, apiFetch } = await transport(fetcher);
  for (let i = 0; i < 2; i++)
    await expect(
      apiFetch("GeckoTerminal", url, undefined, 60000),
    ).rejects.toThrow("UPSTREAM_NETWORK_FAILED");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    apiAccess.snapshot().find((a) => a.api === "GeckoTerminal"),
  ).toMatchObject({
    lastSuccessAt: null,
    lastFailure: {
      phase: "BODY",
      status: 200,
      code: "UPSTREAM_NETWORK_FAILED",
      causeCode: "UND_ERR_SOCKET",
    },
  });
});

it("actual loopback rejects a truncated successful body and never caches or decodes its partial JSON", async () => {
  let calls = 0;
  const server = createServer((_, response) => {
    calls++;
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": "100",
    });
    response.flushHeaders();
    response.write('{"partial":');
    setTimeout(() => response.destroy(), 20);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { apiAccess, apiFetch } = await transport();
  try {
    const { port } = server.address() as { port: number };
    for (let i = 0; i < 2; i++)
      await expect(
        apiFetch(
          "GeckoTerminal",
          `http://127.0.0.1:${port}/partial`,
          undefined,
          60000,
        ),
      ).rejects.toThrow("UPSTREAM_NETWORK_FAILED");
    expect(calls).toBe(2);
    expect(
      apiAccess.snapshot().find((a) => a.api === "GeckoTerminal"),
    ).toMatchObject({
      lastSuccessAt: null,
      lastFailure: {
        phase: "BODY",
        status: 200,
        code: "UPSTREAM_NETWORK_FAILED",
      },
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
