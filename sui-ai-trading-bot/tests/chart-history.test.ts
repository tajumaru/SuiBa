import { apiAccess } from "../packages/shared/src/api.ts";
import { it, expect } from "vitest";
import {
  ChartHistoryStore,
  historyQuery,
} from "../apps/worker/src/chart-history.ts";
import { ChartHistoryClient } from "../apps/worker/src/chart-history-client.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const to = Date.UTC(2026, 9, 30) / 1000,
  from = to - 7 * 86400,
  q = { timeframe: 300 as const, from, to };
const rows = Array.from({ length: 2016 }, (_, i) => [
  (from + i * 300) * 1000,
  2,
  3,
  1,
  2.5,
  10,
]);
function harness(fail?: number) {
  let now = to * 1000,
    calls = 0;
  const store = new ChartHistoryStore(":memory:", {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    gate: async () => true,
    fetch: async (input) => {
      calls++;
      if (fail)
        return new Response("{}", {
          status: fail,
          headers: { "retry-after": "60" },
        });
      const u = new URL(String(input)),
        a = Number(u.searchParams.get("start_time")),
        b = Number(u.searchParams.get("end_time"));
      return Response.json({
        candles: rows.filter((r) => r[0] >= a && r[0] <= b).slice(-1000),
      });
    },
  });
  return { store, calls: () => calls };
}
it("pages 2016 bars, caches coverage and preserves provenance without touching trading data", async () => {
  const h = harness();
  const r = await h.store.get(q);
  expect(r.candles).toHaveLength(2016);
  expect(r.missing).toBe(0);
  expect(h.calls()).toBe(3);
  expect(r.candles[0].timestamp).toBe(from);
  expect(r.candles.at(-1)!.timestamp).toBe(to - 300);
  const again = await h.store.get(q);
  expect(again.cacheHit).toBe(true);
  expect(h.calls()).toBe(3);
  expect(again.candles[0].provenance?.origin).toBe("ORIGINAL");
  h.store.close();
});
it("429 sets persistent cooldown and does not retry indefinitely", async () => {
  const h = harness(429);
  const r = await h.store.get(q);
  expect(r.error).toBe("CHART_HTTP_429");
  expect(r.nextRetryAt).toBeGreaterThan(to * 1000);
  await h.store.get(q);
  expect(h.calls()).toBe(1);
  h.store.close();
});
it("503 retries only once and returns partial evidence", async () => {
  const h = harness(503);
  const r = await h.store.get(q);
  expect(r.error).toBe("CHART_HTTP_503");
  expect(h.calls()).toBe(2);
  h.store.close();
});
it("invalid ranges and excessive future/history inputs are rejected", () => {
  for (const p of [
    "timeframe=60&from=1&to=2",
    `timeframe=300&from=${from}&to=${to + 9999999}`,
    `timeframe=300&from=${from + 1}&to=${to}`,
  ])
    expect(() => historyQuery(new URLSearchParams(p), to * 1000)).toThrow(
      "INVALID_CHART_RANGE",
    );
  expect(
    historyQuery(
      new URLSearchParams(`timeframe=300&from=${from}&to=${to}`),
      to * 1000,
    ),
  ).toEqual(q);
});
it("gate refuses external work before sending any request", async () => {
  let calls = 0;
  const s = new ChartHistoryStore(":memory:", {
    now: () => to * 1000,
    sleep: async () => {},
    gate: async () => false,
    fetch: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  const r = await s.get(q);
  expect(r.error).toBe("CHART_DEFERRED_FOR_MARKET");
  expect(calls).toBe(0);
  s.close();
});
it("a timeout has a strict retry bound", async () => {
  let calls = 0;
  const s = new ChartHistoryStore(":memory:", {
    now: () => to * 1000,
    sleep: async () => {},
    gate: async () => true,
    fetch: async () => {
      calls++;
      throw new DOMException("timeout", "TimeoutError");
    },
  });
  expect((await s.get(q)).error).toBe("CHART_TIMEOUT");
  expect(calls).toBe(2);
  s.close();
});
it("worker thread reuses persisted cache and coalesces equal requests", async () => {
  const folder = mkdtempSync(join(tmpdir(), "suiba-chart-")),
    path = join(folder, "chart.sqlite");
  let now = Date.now();
  const t = Math.floor(now / 300000) * 300,
    q = { timeframe: 300 as const, from: t - 600, to: t };
  const s = new ChartHistoryStore(path, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    gate: async () => true,
    fetch: async () =>
      Response.json({ candles: [[(t - 600) * 1000, 2, 3, 1, 2, 0]] }),
  });
  await s.get(q);
  s.close();
  const client = new ChartHistoryClient(path, () => false);
  try {
    const a = client.get(q, []),
      b = client.get(q, []);
    expect(a).toBe(b);
    const r = await a;
    expect(r.cacheHit).toBe(true);
    expect(r.candles).toHaveLength(1);
    expect(r.missing).toBe(1);
  } finally {
    client.close();
    await new Promise((r) => setTimeout(r, 100));
    rmSync(folder, { recursive: true, force: true });
  }
});

it("preserves seeded verified reconstruction when historical raw data has a gap", async () => {
  const s = new ChartHistoryStore(":memory:", {
    now: () => to * 1000,
    sleep: async () => {},
    gate: async () => true,
    fetch: async () => Response.json({ candles: [] }),
  });
  const candle = {
    timestamp: from,
    timeframe: 300 as const,
    open: 2,
    high: 3,
    low: 1,
    close: 2,
    volume: 0,
    source: "DeepBook:SUI_USDC:USDC:verified-v1",
    provenance: {
      origin: "NO_INDEXED_TRADES" as const,
      upstream: "DeepBook Indexer" as const,
      pair: "SUI_USDC" as const,
      fetchedAt: to * 1000,
      timeframe: 300,
      evidence: ["verified test proof"],
    },
  };
  s.seed([candle]);
  const r = await s.get(q);
  expect(r.candles[0]).toEqual(candle);
  expect(r.missing).toBe(2015);
  expect(r.cacheHit).toBe(false);
  expect((await s.get(q)).cacheHit).toBe(true);
  s.close();
});
it("cancelled work returns partial cache instead of retrying or inventing bars", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const s = new ChartHistoryStore(":memory:", {
    now: () => to * 1000,
    sleep: async () => {},
    gate: async () => true,
    fetch: async () => {
      calls++;
      throw Error("unexpected");
    },
  });
  const r = await s.get(q, controller.signal);
  expect(r.error).toBe("CHART_CANCELLED");
  expect(calls).toBe(0);
  expect(r.candles).toHaveLength(0);
  s.close();
});
it("overlapping seed data is keyed by market time and does not duplicate rows", async () => {
  const s = new ChartHistoryStore(":memory:", {
    now: () => to * 1000,
    sleep: async () => {},
    gate: async () => true,
    fetch: async () => Response.json({ candles: [] }),
  });
  const candle = {
    timestamp: from,
    timeframe: 300 as const,
    open: 2,
    high: 3,
    low: 1,
    close: 2,
    volume: 1,
    source: "DeepBook:SUI_USDC:USDC",
  };
  s.seed([candle, candle]);
  expect((await s.get(q)).candles).toHaveLength(1);
  s.close();
});

it("history failures do not mutate the trading API controller", async () => {
  const before = JSON.stringify(apiAccess.snapshot());
  const h = harness(429);
  expect((await h.store.get(q)).error).toBe("CHART_HTTP_429");
  expect(JSON.stringify(apiAccess.snapshot())).toBe(before);
  h.store.close();
});
it("authoritative original rows supersede cached no-trade reconstructions", async () => {
  const { verifiedDisplayRepairs } =
    await import("../packages/shared/src/chart-gap-audit.ts");
  const repair = verifiedDisplayRepairs[0];
  const store = new ChartHistoryStore(":memory:", {
    now: () => (repair.timestamp + 600) * 1000,
    sleep: async () => {},
    gate: async () => true,
    fetch: async () =>
      Response.json({ candles: [[repair.timestamp * 1000, 2, 3, 1, 2.5, 10]] }),
  });
  store.seed([repair]);
  const r = await store.get({
    timeframe: 300,
    from: repair.timestamp,
    to: repair.timestamp + 300,
  });
  expect(r.candles[0].provenance?.origin).toBe("ORIGINAL");
  expect(r.candles[0].volume).toBe(10);
  store.close();
});
