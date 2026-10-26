import { afterEach, expect, it, vi } from "vitest";
import { verifyToken } from "../apps/dashboard/src/verifyToken.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { DashboardService } from "../apps/worker/src/dashboard-feed.ts";
const state = {
  mode: "PAPER",
  runtime: { running: false, emergency: false },
  settings: {},
  portfolio: {},
  candles: [],
  trades: [],
  orders: [],
  riskEvents: [],
};
const summary = {
  schema: 1,
  generatedAt: 1,
  summary: state,
  frames: { 300: "a", 900: "b", 3600: "c" },
  recordsVersion: "r",
};
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
afterEach(() => vi.useRealTimers());
it("sends the existing bearer credential on a read-only uncached request", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(json(summary));
  expect(await verifyToken("test-only", undefined, request)).toMatchObject({
    ok: true,
  });
  expect(request).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledWith(
    "/api/dashboard/summary",
    expect.objectContaining({
      headers: { Authorization: "Bearer test-only" },
      cache: "no-store",
      redirect: "error",
    }),
  );
});
it("accepts real Worker summary and legacy state envelopes", async () => {
  const db = new BotDatabase(":memory:");
  try {
    const status = { healthy: true, checkedAt: Date.now(), failures: 0 };
    const engine = new BotEngine(
      db,
      { candles: async () => [] },
      {
        getQuote: async () => {
          throw Error("unused");
        },
        validateQuote: async () => false,
      },
      { health: async () => status, status },
    );
    expect(
      await verifyToken("test", undefined, async () =>
        json(new DashboardService(engine, db).summary()),
      ),
    ).toMatchObject({ ok: true });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(null, 404))
      .mockResolvedValueOnce(json(engine.snapshot()));
    expect(await verifyToken("test", undefined, request)).toMatchObject({
      ok: true,
    });
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "/api/dashboard/summary",
      "/api/state",
    ]);
  } finally {
    db.close();
  }
});
it.each([
  null,
  [],
  {},
  "html",
  { ...summary, schema: 2 },
  { ...summary, summary: null },
  { ...summary, frames: {} },
  { ...summary, recordsVersion: null },
])("rejects unexpected JSON: %j", async (v) => {
  expect(
    await verifyToken("test", undefined, async () => json(v)),
  ).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
});
it.each([
  ["<html>wrong</html>", "text/html"],
  ["null", "application/json"],
  ["{bad", "application/json"],
  [JSON.stringify(summary), "text/plain"],
])("rejects malformed/non-JSON success: %s", async (body, type) => {
  expect(
    await verifyToken(
      "test",
      undefined,
      async () => new Response(body, { headers: { "content-type": type } }),
    ),
  ).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
});
it.each(["null", "{bad", "<html>no</html>"])(
  "classifies 401 despite body: %s",
  async (body) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(body, { status: 401 }));
    expect(await verifyToken("test", undefined, request)).toMatchObject({
      ok: false,
      code: "UNAUTHORIZED",
    });
    expect(request).toHaveBeenCalledOnce();
  },
);
it("only falls back for 404 and validates legacy response", async () => {
  for (const status of [403, 500, 503]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json(null, status));
    expect(await verifyToken("test", undefined, request)).toMatchObject({
      ok: false,
      code: `HTTP_${status}`,
    });
    expect(request).toHaveBeenCalledOnce();
  }
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(null, 404))
    .mockResolvedValueOnce(json(null));
  expect(await verifyToken("test", undefined, request)).toMatchObject({
    ok: false,
    code: "INVALID_RESPONSE",
  });
});
const hanging: typeof fetch = async (_url, init) =>
  new Promise((_resolve, reject) =>
    init!.signal!.addEventListener("abort", () => reject(Error("aborted"))),
  );
it("times out and permits retry without AbortSignal.timeout/any", async () => {
  vi.useFakeTimers();
  const pending = verifyToken("test", undefined, hanging);
  await vi.advanceTimersByTimeAsync(8000);
  expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
  expect(
    await verifyToken("test", undefined, async () => json(summary)),
  ).toMatchObject({ ok: true });
});
it("bounds body reads and shares the deadline with fallback", async () => {
  vi.useFakeTimers();
  const request = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return json(null, 404);
    })
    .mockImplementationOnce(
      async (_url, init) =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            new Promise((_resolve, reject) =>
              init!.signal!.addEventListener("abort", () =>
                reject(Error("aborted body")),
              ),
            ),
        }) as Response,
    );
  const pending = verifyToken("test", undefined, request);
  await vi.advanceTimersByTimeAsync(8000);
  expect(await pending).toEqual({ ok: false, code: "TIMEOUT" });
  expect(request).toHaveBeenCalledTimes(2);
});
it("handles cancellation and transport failure", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = vi.fn<typeof fetch>();
  expect(await verifyToken("test", controller.signal, request)).toEqual({
    ok: false,
    code: "CANCELLED",
  });
  expect(request).not.toHaveBeenCalled();
  expect(
    await verifyToken("test", undefined, async () => {
      throw Error("disconnected");
    }),
  ).toEqual({ ok: false, code: "NETWORK" });
});
