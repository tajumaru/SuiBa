import { afterEach, expect, it, vi } from "vitest";
import { GrpcTypes } from "@mysten/sui/grpc";
import { ReadOnlySuiClient } from "../packages/sui-client/src/index.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
import { createChainInfoFetcher } from "../apps/worker/src/chainInfo.ts";

const clients: ReadOnlySuiClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Same cleanup contract as sui-observations: close a breaker a
  // failing fixture opened through its real probe path.
  if (
    apiAccess
      .snapshot()
      .some((a) => a.api === "Sui gRPC" && a.consecutiveFailures > 0)
  ) {
    vi.useFakeTimers();
    const probe = apiAccess.run(
      "Sui gRPC",
      "fixture-cleanup",
      async () => undefined,
    );
    await vi.runAllTimersAsync();
    await probe;
    vi.useRealTimers();
  }
  apiAccess.reset();
  vi.restoreAllMocks();
});

function frame(flag: number, bytes: Uint8Array) {
  const b = Buffer.alloc(5 + bytes.length);
  b[0] = flag;
  b.writeUInt32BE(bytes.length, 1);
  b.set(bytes, 5);
  return b;
}
function grpcText(payload: Uint8Array) {
  return new Response(
    Buffer.concat([
      frame(0, payload),
      frame(128, Buffer.from("grpc-status: 0\r\n")),
    ]).toString("base64"),
    { headers: { "content-type": "application/grpc-web-text" } },
  );
}
function requestText(init?: RequestInit): string {
  const body = init?.body;
  if (typeof body === "string")
    return Buffer.from(body, "base64").toString("latin1");
  if (body instanceof Uint8Array)
    return Buffer.from(body).toString("latin1");
  return "";
}
function coinInfoResponse(init?: RequestInit) {
  // The coin type travels verbatim inside the protobuf request.
  const decimals = requestText(init).includes("usdc::USDC") ? 6 : 9;
  return grpcText(
    GrpcTypes.GetCoinInfoResponse.toBinary(
      GrpcTypes.GetCoinInfoResponse.create({ metadata: { decimals } }),
    ),
  );
}

type HostBehaviour = "ok" | "throw" | number;
function hostRouter(behaviour: Record<string, HostBehaviour>, calls: string[]) {
  return async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const host = new URL(url).hostname;
    calls.push(host);
    const b = behaviour[host] ?? "ok";
    if (b === "throw") throw new TypeError("fetch failed");
    if (typeof b === "number") return new Response("error", { status: b });
    return coinInfoResponse(init);
  };
}
function clientWith(
  behaviour: Record<string, HostBehaviour>,
  calls: string[],
) {
  const c = new ReadOnlySuiClient("https://primary.test:443", {
    fetch: hostRouter(behaviour, calls) as typeof fetch,
    fallbackUrls: ["https://fallback.test:443"],
  });
  clients.push(c);
  return c;
}

it("fails over to the fallback endpoint on a transport failure and sticks to it", async () => {
  const calls: string[] = [];
  const c = clientWith({ "primary.test": "throw", "fallback.test": "ok" }, calls);
  expect(c.readStatus.endpoint).toBe("primary.test");
  await c.health();
  expect(c.status.healthy).toBe(true);
  expect(c.readStatus.endpoint).toBe("fallback.test");
  const primaryCalls = calls.filter((h) => h === "primary.test").length;
  expect(primaryCalls).toBeGreaterThan(0);
  await c.health(true);
  // Sticky: the healthy check never touches the dead primary again.
  expect(calls.filter((h) => h === "primary.test").length).toBe(primaryCalls);
  expect(c.readStatus.endpoint).toBe("fallback.test");
});

it("fails over when the primary answers a gateway error", async () => {
  const calls: string[] = [];
  const c = clientWith({ "primary.test": 503, "fallback.test": "ok" }, calls);
  await c.health();
  expect(c.status.healthy).toBe(true);
  expect(c.readStatus.endpoint).toBe("fallback.test");
});

it("surfaces the ordinary read failure when every endpoint is down", async () => {
  const calls: string[] = [];
  const c = clientWith(
    { "primary.test": "throw", "fallback.test": "throw" },
    calls,
  );
  await expect(c.health()).rejects.toThrow("SUI_READ_FAILED");
  expect(c.status.healthy).toBe(false);
  expect(calls).toContain("primary.test");
  expect(calls).toContain("fallback.test");
});

it("does not fail over on a client error from the primary", async () => {
  const calls: string[] = [];
  const c = clientWith({ "primary.test": 400, "fallback.test": "ok" }, calls);
  await expect(c.health()).rejects.toThrow("SUI_READ_FAILED");
  expect(calls.filter((h) => h === "fallback.test").length).toBe(0);
});

it("chain info fetcher fails over to the next endpoint and sticks to it", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const host = new URL(url).hostname;
      calls.push(host);
      if (host === "primary.test") throw new TypeError("fetch failed");
      if (url.includes("GetServiceInfo"))
        return grpcText(
          GrpcTypes.GetServiceInfoResponse.toBinary(
            GrpcTypes.GetServiceInfoResponse.create({
              epoch: 1300n,
              checkpointHeight: 5000n,
            }),
          ),
        );
      if (url.includes("GetCheckpoint"))
        return grpcText(
          GrpcTypes.GetCheckpointResponse.toBinary(
            GrpcTypes.GetCheckpointResponse.create({
              checkpoint: {
                summary: { totalNetworkTransactions: 777000n },
              },
            }),
          ),
        );
      // Garnish reads may fail on their own; the sample still counts.
      throw new TypeError("unsupported call");
    },
  );
  const fetcher = createChainInfoFetcher("https://primary.test:443", [
    "https://fallback.test:443",
  ]);
  const sample = await fetcher();
  expect(sample).toMatchObject({
    epoch: 1300,
    checkpoint: 5000,
    totalNetworkTransactions: 777000,
  });
  const primaryCalls = calls.filter((h) => h === "primary.test").length;
  expect(primaryCalls).toBeGreaterThan(0);
  const second = await fetcher();
  expect(second).toMatchObject({ epoch: 1300, checkpoint: 5000 });
  expect(calls.filter((h) => h === "primary.test").length).toBe(primaryCalls);
});
