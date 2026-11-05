import { it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import {
  DashboardService,
  acceptsGzip,
} from "../apps/worker/src/dashboard-feed.ts";
import { DashboardClient } from "../apps/dashboard/src/dashboardClient.ts";
import { chartFixture } from "./chart-fixture.ts";
function fixture() {
  const db = new BotDatabase(":memory:"),
    status = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw Error("NO_TRADE");
      },
      validateQuote: async () => false,
    },
    { health: async () => status, status },
  );
  engine.monitor.boot();
  for (const tf of [300, 900, 3600] as const)
    db.saveCandles(
      chartFixture().map((c, i) => ({
        ...c,
        timeframe: tf,
        timestamp: c.timestamp - i * 300 + i * tf,
      })),
    );
  const service = new DashboardService(engine, db);
  return { db, engine, service };
}
function localApi(service: DashboardService) {
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path);
    const u = new URL("http://localhost/" + path);
    if (u.pathname === "/dashboard/summary") return service.summary();
    if (u.pathname === "/dashboard/candles")
      return service.candles(
        Number(u.searchParams.get("timeframe")) as 300,
        u.searchParams.get("version"),
      );
    if (u.pathname === "/dashboard/records") return service.records();
    if (u.pathname === "/dashboard/long-term") return service.longTerm();
    throw Error("UNEXPECTED_API");
  };
  return { api, calls };
}
it("summary is small, keeps safety and does not send charts/logs", () => {
  const { db, engine, service } = fixture(),
    full = engine.snapshot(),
    light = service.summary();
  expect(light.summary.runtime).toEqual(full.runtime);
  expect(light.summary.settings).toEqual(full.settings);
  expect("candles" in light.summary).toBe(false);
  expect("riskEvents" in light.summary).toBe(false);
  const before = Buffer.byteLength(JSON.stringify(full)),
    after = Buffer.byteLength(JSON.stringify(light));
  expect(after / before).toBeLessThan(0.2);
  console.info(
    JSON.stringify({
      beforeBytes: before,
      summaryBytes: after,
      gzipSummaryBytes: gzipSync(JSON.stringify(light)).length,
      reduction: 1 - after / before,
    }),
  );
  db.close();
});
it("unchanged data is not resent and a new bar produces one upsert and one removal", () => {
  const { db, service } = fixture();
  const first = service.candles(300, null);
  expect(first.reset).toBe(true);
  expect(service.candles(300, first.version).upserts).toHaveLength(0);
  const last = chartFixture().at(-1)!;
  db.saveCandles([{ ...last, timestamp: last.timestamp + 300 }]);
  const delta = service.candles(300, first.version);
  expect(delta.reset).toBe(false);
  expect(delta.upserts).toHaveLength(1);
  expect(delta.removed).toHaveLength(1);
  expect(service.candles(300, "lost-cursor").reset).toBe(true);
  db.close();
});
it("frontend polls summary only until versions change, recovers missing delta", async () => {
  const { db, service } = fixture(),
    { api, calls } = localApi(service),
    client = new DashboardClient();
  const first = await client.poll(api, 300, true, () => {});
  expect(first.state.candles).toHaveLength(1000);
  calls.length = 0;
  await client.poll(api, 300, true, () => {});
  expect(calls).toEqual(["dashboard/summary"]);
  const last = chartFixture().at(-1)!;
  db.saveCandles([{ ...last, timestamp: last.timestamp + 300 }]);
  let injected = false;
  const corrupt = async (path: string) => {
    const r = await api(path);
    if (path.includes("version=") && !injected) {
      injected = true;
      return { ...r, baseVersion: "wrong" };
    }
    return r;
  };
  expect(
    (await client.poll(corrupt, 300, true, () => {})).channelError,
  ).toBeNull();
  expect(calls.some((c) => c === "dashboard/candles?timeframe=300")).toBe(true);
  db.close();
});
it("light summary publishes stop immediately even when chart retrieval fails", async () => {
  const { db, service } = fixture(),
    client = new DashboardClient(),
    published: ReturnType<BotEngine["snapshot"]>[] = [];
  db.set("runtime", {
    ...db.runtime(),
    running: false,
    error: "MARKET_DATA_STALLED",
  });
  const api = async (path: string) => {
    if (path === "dashboard/summary") return service.summary();
    throw Error("offline");
  };
  const result = await client.poll(api, 300, true, (state) =>
    published.push(state),
  );
  expect(published[0].runtime.error).toBe("MARKET_DATA_STALLED");
  expect(result.channelError).not.toBeNull();
  db.close();
});
it("checksum failures never replace existing chart data and retry with full data", async () => {
  const { db, service } = fixture(),
    { api } = localApi(service),
    client = new DashboardClient();
  const first = await client.poll(api, 300, true, () => {});
  const last = chartFixture().at(-1)!;
  db.saveCandles([{ ...last, timestamp: last.timestamp + 300 }]);
  const broken = async (path: string) => {
    const r = await api(path);
    return path.startsWith("dashboard/candles") ? { ...r, upserts: [] } : r;
  };
  const result = await client.poll(broken, 300, true, () => {});
  expect(result.channelError).not.toBeNull();
  expect(result.state.candles).toEqual(first.state.candles);
  const recovered = await client.poll(api, 300, true, () => {});
  expect(recovered.channelError).toBeNull();
  expect(recovered.state.candles.at(-1)?.timestamp).toBe(last.timestamp + 300);
  db.close();
});
it("timeframe changes reuse previously received history and hidden charts do not fetch", async () => {
  const { db, service } = fixture(),
    { api, calls } = localApi(service),
    client = new DashboardClient();
  await client.poll(api, 300, true, () => {});
  await client.poll(api, 900, false, () => {});
  calls.length = 0;
  await client.poll(api, 300, false, () => {});
  expect(calls).toEqual(["dashboard/summary"]);
  await client.poll(api, null, false, () => {});
  expect(calls).toEqual(["dashboard/summary", "dashboard/summary"]);
  db.close();
});
it("gzip negotiation respects q=0", () => {
  expect(acceptsGzip("gzip, deflate, br")).toBe(true);
  expect(acceptsGzip("gzip;q=0")).toBe(false);
  expect(acceptsGzip(undefined)).toBe(false);
});

it("status is published while an earlier candle request is still pending", async () => {
  const { db, service } = fixture(),
    client = new DashboardClient();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((r) => (entered = r)),
    hold = new Promise<void>((r) => (release = r));
  const { api } = localApi(service);
  const blocked = async (path: string) => {
    if (path.startsWith("dashboard/candles")) {
      entered();
      await hold;
    }
    return api(path);
  };
  const first = client.poll(blocked, 300, false, () => {});
  await waiting;
  db.set("runtime", {
    ...db.runtime(),
    running: false,
    error: "MARKET_DATA_STALLED",
  });
  let publish!: () => void;
  const shown = new Promise<void>((r) => (publish = r));
  const second = client.poll(api, 300, false, (state) => {
    expect(state.runtime.error).toBe("MARKET_DATA_STALLED");
    publish();
  });
  await shown;
  release();
  await Promise.all([first, second]);
  db.close();
});
it("changed records replace the complete bounded record snapshot", async () => {
  const { db, service } = fixture(),
    client = new DashboardClient(),
    { api } = localApi(service);
  await client.poll(api, null, true, () => {});
  db.append("risk_events", "new", { timestamp: 1, reason: "TEST" });
  const next = await client.poll(api, null, true, () => {});
  expect(next.state.riskEvents).toEqual(db.history("risk_events"));
  db.close();
});
it("late summary responses cannot overwrite a newer stop state", async () => {
  const { db, service } = fixture(),
    client = new DashboardClient();
  let release!: (v: unknown) => void;
  const held = new Promise<unknown>((r) => (release = r)),
    old = service.summary();
  old.summary.runtime = { ...old.summary.runtime, running: true };
  const first = client.poll(
    async () => held,
    null,
    false,
    () => {},
  );
  db.set("runtime", {
    ...db.runtime(),
    running: false,
    error: "MARKET_DATA_STALLED",
  });
  const { api } = localApi(service);
  await client.poll(api, null, false, () => {});
  release(old);
  const late = await first;
  expect(late.state.runtime.running).toBe(false);
  expect(late.state.runtime.error).toBe("MARKET_DATA_STALLED");
  db.close();
});

it("starts records before a slow chart completes and preserves both channel results", async () => {
  const { db, service } = fixture(),
    client = new DashboardClient(),
    { api } = localApi(service);
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  let recordsEntered!: () => void;
  const entered = new Promise<void>((r) => {
    recordsEntered = r;
  });
  const pending = client.poll(
    async (path) => {
      if (path.startsWith("dashboard/candles")) await hold;
      if (path === "dashboard/records") recordsEntered();
      return api(path);
    },
    300,
    true,
    () => {},
  );
  // Would time out under the old sequential chart-then-records implementation.
  try {
    await entered;
  } finally {
    release();
  }
  const result = await pending;
  expect(result.channelError).toBeNull();
  expect(result.state.candles.length).toBeGreaterThan(0);
  expect(result.state.orders).toEqual(service.records().records.orders);
  db.close();
});
it.each(["candles", "records"])(
  "a failed %s channel does not prevent its sibling from updating",
  async (failed) => {
    const { db, service } = fixture(),
      client = new DashboardClient(),
      { api, calls } = localApi(service);
    const result = await client.poll(
      async (path) => {
        if (path.startsWith(`dashboard/${failed}`))
          throw Error("SIMULATED_CHANNEL_FAILURE");
        return api(path);
      },
      300,
      true,
      () => {},
    );
    expect(result.channelError).not.toBeNull();
    if (failed === "candles") expect(calls).toContain("dashboard/records");
    else expect(result.state.candles.length).toBeGreaterThan(0);
    const recovered = await client.poll(api, 300, true, () => {});
    expect(recovered.channelError).toBeNull();
    expect(recovered.state.candles.length).toBeGreaterThan(0);
    db.close();
  },
);

function longTermFixture() {
  const db = new BotDatabase(":memory:"),
    status = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const day = 86400,
    t0 = 1735689600;
  const makeDaily = (n: number, base: number) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: t0 + i * day,
      open: base + i,
      high: base + i + 1,
      low: base + i - 1,
      close: base + i + 0.5,
      volume: 100 + i,
    }));
  let daily: ReturnType<typeof makeDaily> | null = makeDaily(40, 1.0);
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw Error("NO_TRADE");
      },
      validateQuote: async () => false,
    },
    { health: async () => status, status },
    "SUI_USDC",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => daily,
  );
  engine.monitor.boot();
  const service = new DashboardService(engine, db);
  return {
    db,
    service,
    setDaily: (d: ReturnType<typeof makeDaily> | null) => {
      daily = d;
    },
    makeDaily,
  };
}

it("summary ships only the long-term version; the daily series has its own channel", async () => {
  const { db, service, setDaily, makeDaily } = longTermFixture();
  const light = service.summary();
  expect("longTermDaily" in light.summary).toBe(false);
  expect(typeof light.longTermVersion).toBe("string");
  const first = service.longTerm();
  expect(first.schema).toBe(1);
  expect(first.version).toBe(light.longTermVersion);
  expect(first.daily).toHaveLength(40);
  // Same series, new poll: the version is stable.
  expect(service.summary().longTermVersion).toBe(light.longTermVersion);
  // A refreshed series changes the version and the payload.
  setDaily(makeDaily(41, 1.2));
  const next = service.summary();
  expect(next.longTermVersion).not.toBe(light.longTermVersion);
  expect(service.longTerm().daily).toHaveLength(41);
  // The client fetches the series once per version, not per poll.
  const { api, calls } = localApi(service);
  const client = new DashboardClient();
  const one = await client.poll(api, null, false, () => {});
  expect(one.state.longTermDaily).toHaveLength(41);
  await client.poll(api, null, false, () => {});
  expect(calls.filter((c) => c === "dashboard/long-term")).toHaveLength(1);
  setDaily(makeDaily(42, 1.3));
  const three = await client.poll(api, null, false, () => {});
  expect(three.state.longTermDaily).toHaveLength(42);
  expect(calls.filter((c) => c === "dashboard/long-term")).toHaveLength(2);
  db.close();
});

it("a pair without a daily series reports null and the client copes", async () => {
  const { db, service } = fixture();
  const light = service.summary();
  expect("longTermDaily" in light.summary).toBe(false);
  expect(service.longTerm().daily).toBeNull();
  const { api } = localApi(service);
  const client = new DashboardClient();
  const result = await client.poll(api, null, false, () => {});
  expect(result.state.longTermDaily ?? null).toBeNull();
  expect(result.channelError).toBeNull();
  db.close();
});
