import { it, expect } from "vitest";
import {
  ChartHistoryStore,
  historyQuery,
} from "../apps/worker/src/chart-history.ts";
import { ChartHistoryClient } from "../apps/worker/src/chart-history-client.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const to = Date.UTC(2026, 9, 22) / 1000,
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
