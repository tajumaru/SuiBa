import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUsdJpyFetcher,
  FxRateSampler,
} from "../apps/worker/src/fx-rate.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("USD/JPY display rate", () => {
  it("parses rates.JPY from a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ rates: { JPY: 154.321 } }), {
          status: 200,
        }),
      ),
    );
    await expect(createUsdJpyFetcher()()).resolves.toBe(154.321);
  });

  it("returns null for fetch, HTTP, or malformed response failures", async () => {
    const fetcher = createUsdJpyFetcher();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(fetcher()).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    await expect(fetcher()).resolves.toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ rates: { JPY: -1 } }))),
    );
    await expect(fetcher()).resolves.toBeNull();
  });

  it("keeps the last good in-memory value when a later value is invalid", () => {
    const sampler = new FxRateSampler();
    expect(sampler.current()).toBeNull();
    expect(sampler.observe(150.5, 1234)).toEqual({ usdJpy: 150.5, asOf: 1234 });
    expect(sampler.observe(Number.NaN, 5678)).toEqual({ usdJpy: 150.5, asOf: 1234 });
    expect(sampler.current()).toEqual({ usdJpy: 150.5, asOf: 1234 });
  });

  it("exposes the in-memory rate and acquisition time on the snapshot", () => {
    const db = new BotDatabase(":memory:");
    const fx = { usdJpy: 151.25, asOf: 1234 };
    const monitor = new OperationMonitor(
      db,
      0,
      () => 0,
      "PAPER",
      () => fx,
    );
    expect(monitor.snapshot(2000).fx).toEqual(fx);
    db.close();
  });
});
