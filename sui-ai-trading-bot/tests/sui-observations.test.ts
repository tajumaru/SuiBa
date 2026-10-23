import { afterEach, expect, it, vi } from "vitest";
import { GrpcTypes } from "@mysten/sui/grpc";
import {
  ReadOnlySuiClient,
  type SuiObservation,
} from "../packages/sui-client/src/index.ts";
import { apiAccess } from "../packages/shared/src/api.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { withReadBudget } from "../packages/shared/src/read-budget-node.ts";
const clients: ReadOnlySuiClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
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
function validResponse(decimals: number) {
  const message = GrpcTypes.GetCoinInfoResponse.toBinary(
    GrpcTypes.GetCoinInfoResponse.create({ metadata: { decimals } }),
  );
  return new Response(
    Buffer.concat([
      frame(0, message),
      frame(128, Buffer.from("grpc-status: 0\r\n")),
    ]).toString("base64"),
    { headers: { "content-type": "application/grpc-web-text" } },
  );
}
function fixture(fetcher: typeof fetch) {
  const events: SuiObservation[] = [];
  const c = new ReadOnlySuiClient(undefined, {
    fetch: fetcher,
    onObservation: (e) => events.push(e),
  });
  clients.push(c);
  return { c, events };
}
it("persists separate HTTP, gRPC status, metadata and complete health outcomes with linked IDs", async () => {
  let n = 0;
  const fetcher = vi.fn(async () => validResponse(n++ ? 6 : 9));
  const { c, events } = fixture(fetcher);
  await c.health();
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const layer of ["HTTP", "GRPC", "METADATA"] as const) {
    expect(events.filter((e) => e.layer === layer)).toHaveLength(2);
    expect(
      events.filter((e) => e.layer === layer).every((e) => e.success),
    ).toBe(true);
  }
  const http = events.filter((e) => e.layer === "HTTP");
  for (const h of http) {
    expect(h.httpStatus).toBe(200);
    expect(
      events.find((e) => e.layer === "GRPC" && e.rpcId === h.rpcId)?.grpcStatus,
    ).toBe("OK");
    expect(
      events.find((e) => e.layer === "METADATA" && e.requestId === h.requestId)
        ?.success,
    ).toBe(true);
  }
  expect(new Set(events.map((e) => e.healthId)).size).toBe(1);
  const counts = events.length;
  await c.health();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(events.slice(counts)).toMatchObject([
    { layer: "HEALTH", cacheHit: true },
  ]);
});
it("HTTP200 plus gRPC UNAVAILABLE is transport success, RPC failure and metadata failure", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response("", {
        headers: {
          "content-type": "application/grpc-web-text",
          "grpc-status": "14",
          "grpc-message": "private%20Authorization",
        },
      }),
  );
  const { c, events } = fixture(fetcher);
  await expect(c.health()).rejects.toThrow("SUI_READ_FAILED");
  expect(
    events
      .filter((e) => e.layer === "HTTP")
      .every((e) => e.success && e.httpStatus === 200),
  ).toBe(true);
  expect(events.filter((e) => e.layer === "GRPC")).toMatchObject([
    { success: false, grpcStatus: "UNAVAILABLE" },
    { success: false, grpcStatus: "UNAVAILABLE" },
  ]);
  expect(
    events.filter((e) => e.layer === "METADATA").every((e) => !e.success),
  ).toBe(true);
  expect(c.status.failures).toBe(1);
  expect(JSON.stringify(events)).not.toMatch(
    /private|Authorization|fullnode|coinType/,
  );
});
it("a valid gRPC result containing wrong metadata cannot establish health", async () => {
  const { c, events } = fixture(async () => validResponse(33));
  await expect(c.health()).rejects.toThrow("SUI_READ_FAILED");
  expect(events.filter((e) => e.layer === "GRPC").every((e) => e.success)).toBe(
    true,
  );
  expect(
    events.filter((e) => e.layer === "METADATA").every((e) => !e.success),
  ).toBe(true);
});
it("protobuf decode failure stays distinct from HTTP success", async () => {
  const { c, events } = fixture(
    async () =>
      new Response("not-a-valid-frame", {
        headers: { "content-type": "application/grpc-web-text" },
      }),
  );
  await expect(c.health()).rejects.toThrow("SUI_READ_FAILED");
  expect(events.filter((e) => e.layer === "HTTP")).toHaveLength(2);
  expect(events.filter((e) => e.layer === "HTTP").every((e) => e.success)).toBe(
    true,
  );
  expect(
    events.filter((e) => e.layer === "GRPC").every((e) => !e.success),
  ).toBe(true);
  expect(
    events.filter((e) => e.layer === "METADATA").every((e) => !e.success),
  ).toBe(true);
});
it("stores replayable layered observations in an isolated DB with their worker cycle ID", async () => {
  const db = new BotDatabase(":memory:");
  let n = 0,
    id = 0;
  const c = new ReadOnlySuiClient(undefined, {
    fetch: async () => validResponse(n++ ? 6 : 9),
    onObservation: (event) =>
      db.append("sui_observations", String(id++), event, event.at),
  });
  clients.push(c);
  try {
    await withReadBudget(
      new AbortController().signal,
      true,
      () => c.health(true),
      "fixture-cycle",
    );
    const events = db.history<SuiObservation>("sui_observations", 50);
    expect(events).toHaveLength(7);
    expect(events.every((e) => e.cycleId === "fixture-cycle")).toBe(true);
    expect(new Set(events.map((e) => e.transportId)).size).toBe(1);
    expect(
      new Set(
        events.filter((e) => e.layer !== "HEALTH").map((e) => e.requestId),
      ).size,
    ).toBe(2);
    expect(db.runtime().running).toBe(false);
    expect(db.history("paper_orders")).toHaveLength(0);
  } finally {
    c.close();
    db.close();
  }
});
it("DNS failure remains evidenced, does not retry, and a later full cohort can recover", async () => {
  let fail = true,
    n = 0;
  const fetcher = vi.fn(async () => {
    if (fail)
      throw new TypeError("private error", {
        cause: Object.assign(Error("private"), { code: "EAI_AGAIN" }),
      });
    return validResponse(n++ ? 6 : 9);
  });
  const { c, events } = fixture(fetcher);
  await expect(c.health()).rejects.toThrow("SUI_READ_FAILED");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(events.filter((e) => e.layer === "HTTP").map((e) => e.code)).toEqual([
    "UPSTREAM_DNS_FAILED",
    "UPSTREAM_DNS_FAILED",
  ]);
  expect(
    apiAccess.snapshot().find((e) => e.api === "Sui gRPC")?.lastFailure,
  ).toMatchObject({ causeCode: "EAI_AGAIN", phase: "DNS" });
  fail = false;
  await c.health(true);
  expect(c.status.healthy).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(4);
});
it("uses the existing 10s timeout without retry or late healthy success", async () => {
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() => controller.signal);
  const fetcher = vi.fn(
    async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const fail = () => reject(init!.signal!.reason);
        init!.signal!.addEventListener("abort", fail, { once: true });
        if (init!.signal!.aborted) fail();
      }),
  );
  const { c, events } = fixture(fetcher);
  const pending = c.health();
  await new Promise(setImmediate);
  controller.abort(new DOMException("private timeout", "TimeoutError"));
  await expect(pending).rejects.toThrow("SUI_READ_FAILED");
  expect(timeout.mock.calls.every(([ms]) => ms === 10000)).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(
    events
      .filter((e) => e.layer === "HTTP")
      .every((e) => !e.success && e.code === "UPSTREAM_TIMEOUT"),
  ).toBe(true);
  expect(c.status.healthy).toBe(false);
});
it("body timeout retains received HTTP200 and cannot count as gRPC success", async () => {
  const controller = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
  const { c, events } = fixture(
    async (_input, init) =>
      new Response(
        new ReadableStream({
          start(stream) {
            const fail = () => stream.error(init!.signal!.reason);
            init!.signal!.addEventListener("abort", fail, { once: true });
            if (init!.signal!.aborted) fail();
          },
        }),
        { headers: { "content-type": "application/grpc-web-text" } },
      ),
  );
  const pending = c.health();
  await new Promise(setImmediate);
  controller.abort(new DOMException("timeout", "TimeoutError"));
  await expect(pending).rejects.toThrow("SUI_READ_FAILED");
  expect(events.filter((e) => e.layer === "HTTP")).toMatchObject([
    {
      success: false,
      httpStatus: 200,
      code: "UPSTREAM_BODY_TIMEOUT",
      network: { phase: "BODY" },
    },
    {
      success: false,
      httpStatus: 200,
      code: "UPSTREAM_BODY_TIMEOUT",
      network: { phase: "BODY" },
    },
  ]);
  expect(
    events.filter((e) => e.layer === "GRPC").every((e) => !e.success),
  ).toBe(true);
});
