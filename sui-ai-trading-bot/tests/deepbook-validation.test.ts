import { execFileSync } from "node:child_process";
import { it, expect, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  ValidationRecorder,
  aggregateValidation,
  assertValidationProfile,
  validationLimits,
} from "../apps/worker/src/validation.ts";
import {
  validationMarkdown,
  exportValidationReport,
} from "../apps/worker/src/validation-report.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { ApiAccess, RateLimited } from "../packages/shared/src/api.ts";
import type { MarketStatus } from "../packages/market-data/src/provider.ts";
import type { Candle, Timeframe } from "../packages/shared/src/index.ts";
const start = Date.UTC(2026, 9, 21);
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(path = ":memory:") {
  const db = new BotDatabase(path),
    monitor = new OperationMonitor(db, start);
  monitor.boot(start);
  const recorder = new ValidationRecorder(db);
  return { db, monitor, recorder };
}
function bars(tf: Timeframe = 300, now = start): Candle[] {
  const end = Math.floor(now / (tf * 1000)) * tf - tf;
  return Array.from({ length: 70 }, (_, i) => ({
    timestamp: end - (69 - i) * tf,
    open: 2,
    high: 2.01,
    low: 1.99,
    close: 2,
    volume: 100,
    timeframe: tf,
    source: "DeepBook:SUI_USDC:USDC:verified-v1",
  }));
}
function market(now = start): MarketStatus {
  return {
    configured: "deepbook",
    source: "DeepBook",
    fallback: false,
    lastSuccessAt: now,
    latencyMs: 100,
    reason: null,
    healthy: true,
    bookAt: now,
    bid: 1.999,
    ask: 2.001,
    spread: 0.001,
    diagnostics: {
      indexerLagMs: 1000,
      indexedThrough: now - 1000,
      bidDepthUsdc: 100,
      askDepthUsdc: 100,
    },
    quality: {
      300: {
        upstream: "DeepBook Indexer",
        pair: "SUI_USDC",
        fetchedAt: now,
        timeframe: 300,
        originalCount: 70,
        gapTimestamps: [],
        missing: 0,
        reconstructed: 0,
        unresolved: 0,
        reconstructionMs: 0,
        latestClosedAt: Math.floor(now / 300000) * 300000,
        origins: {
          ORIGINAL: 70,
          ONE_MINUTE_AGGREGATE: 0,
          NO_INDEXED_TRADES: 0,
        },
      },
    },
  };
}
it("does not record until explicit begin, and never silently resets a session", () => {
  const { db, recorder } = setup();
  recorder.attempt({
    api: "DeepBook Indexer",
    success: true,
    code: null,
    latencyMs: 8,
    attempt: 0,
    occurredAt: start,
  });
  expect(recorder.report(start).status).toBe("未開始");
  expect(db.history("validation_events")).toHaveLength(0);
  recorder.begin(start);
  expect(() => recorder.begin(start + 1)).toThrow("VALIDATION_ALREADY_STARTED");
  db.close();
});
it("requires stopped PAPER and Profit Guard for measurement start", () => {
  const { db, recorder } = setup();
  db.set("runtime", { ...db.runtime(), running: true });
  expect(() => recorder.begin(start)).toThrow("STOP_BEFORE_VALIDATION");
  db.set("runtime", { ...db.runtime(), running: false });
  db.updateSettings({ ...db.settings(), profitGuardEnabled: false });
  expect(() => recorder.begin(start)).toThrow("PROFIT_GUARD_REQUIRED");
  db.close();
});
it("reports an incomplete run in JSON and Markdown without pass", () => {
  const { db, recorder } = setup();
  recorder.begin(start);
  const r = recorder.report(start + 3600000, true);
  expect(r.status).toBe("検証途中");
  expect(r.progress).toBeCloseTo(1 / 24);
  expect(validationMarkdown(r)).toContain("検証途中");
  expect(r.criteria?.some((c) => !c.ok)).toBe(true);
  db.close();
});
it("does not pass 24 elapsed hours with missing samples or no PAPER activity", () => {
  const { db, recorder } = setup();
  recorder.begin(start);
  recorder.sample(market(start + 86400000), start + 86400000);
  const r = recorder.report(start + 86400000, true);
  expect(r.status).toContain("要確認");
  expect(r.maxGapMs).toBe(86400000);
  expect(r.paper?.fillChecksExercised).toBe(false);
  db.close();
});
it("aggregates a synthetic complete 24h fixture without truncating at 200 rows", () => {
  const { db, monitor, recorder } = setup();
  recorder.begin(start);
  db.set("runtime", { ...db.runtime(), running: true });
  monitor.transition("MANUAL_START", start + 1);
  db.transaction(() => {
    for (let t = start + 15000; t <= start + 86400000; t += 15000) {
      db.set("operation_state", {
        ...monitor.state(),
        runningMs: t - start,
        active: false,
        lastHeartbeatAt: t,
        accountedAt: t,
      });
      recorder.sample(market(t), t);
      if ((t - start) % 60000 === 0) {
        recorder.attempt({
          api: "DeepBook Indexer",
          success: true,
          code: null,
          latencyMs: 100,
          attempt: 0,
          occurredAt: t,
        });
        recorder.cycle(
          market(t),
          { 300: bars(300, t) },
          "WAIT",
          null,
          t - 100,
          t,
        );
      }
    }
  });
  const r = recorder.report(start + 86400000, true);
  expect(r.status).toBe("合格");
  expect(r.sampleCount).toBe(5761);
  expect(r.paper?.analyses).toBe(1440);
  expect(r.apis?.[0].requests).toBe(1440);
  expect(r.apis?.[0].latency.p95Ms).toBe(100);
  expect(r.paper?.fillChecksExercised).toBe(false);
  expect(r.paper?.errorStopChecksExercised).toBe(false);
  db.close();
});
it("deduplicates candle repairs, retains evidence and does not erase failed cycles", () => {
  const { db, recorder } = setup();
  recorder.begin(start);
  const m = market(),
    q = m.quality![300],
    t = bars()[20].timestamp;
  q.gapTimestamps = [t];
  q.missing = 1;
  q.unresolved = 1;
  recorder.cycle(m, {}, null, "CANDLE_GAP", start, start + 100);
  const c = bars();
  c[20].provenance = {
    origin: "NO_INDEXED_TRADES",
    upstream: "DeepBook Indexer",
    pair: "SUI_USDC",
    fetchedAt: start,
    timeframe: 300,
    evidence: ["/trades/SUI_USDC?start_time=" + t],
  };
  q.unresolved = 0;
  q.reconstructed = 1;
  recorder.cycle(m, { 300: c }, "WAIT", null, start, start + 200);
  recorder.cycle(m, { 300: c }, "WAIT", null, start, start + 300);
  const r = recorder.report(start + 300, true);
  expect(r.candles).toMatchObject({
    originalMissing: 1,
    reconstructed: 1,
    unresolved: 0,
    reconstructionFailures: 1,
  });
  expect(r.candles?.evidence[0].provenance.evidence[0]).toContain("/trades/");
  expect(r.criteria?.find((x) => x.name.startsWith("未解決"))?.ok).toBe(false);
  db.close();
});
it("records unresolved gaps and reconstruction failures without creating fake candles", () => {
  const { db, recorder } = setup();
  recorder.begin(start);
  const m = market();
  Object.assign(m.quality![300], {
    gapTimestamps: [12300, 12600],
    missing: 2,
    unresolved: 2,
    reconstructionMs: 45001,
  });
  recorder.cycle(m, {}, null, "CANDLE_GAP", start, start + 45001);
  const r = recorder.report(start + 45001, true);
  expect(r.candles).toMatchObject({
    reconstructed: 0,
    unresolved: 2,
    uniqueFiveMinuteBars: 0,
  });
  expect(r.candles?.unresolvedTimestamps).toEqual([12300, 12600]);
  db.close();
});
it("persists session, measurements, sticky emergency and existing SQLite history through reboot", () => {
  const d = mkdtempSync(join(tmpdir(), "suiba-validation-"));
  dirs.push(d);
  const path = join(d, "validation.sqlite");
  let { db, recorder } = setup(path);
  recorder.begin(start);
  const id = recorder.session()!.id;
  db.append("risk_events", "old", { code: "KEPT" }, start - 1);
  db.set("runtime", {
    ...db.runtime(),
    running: true,
    emergency: true,
    error: "UPSTREAM_TIMEOUT",
  });
  db.close();
  ({ db, recorder } = setup(path));
  expect(recorder.session()?.id).toBe(id);
  expect(db.runtime()).toMatchObject({
    running: false,
    emergency: true,
    error: "UPSTREAM_TIMEOUT",
  });
  expect(db.history("risk_events")).toEqual([{ code: "KEPT" }]);
  recorder.sample(null, start + 15000);
  expect(recorder.report(start + 15000, true).sampleCount).toBe(2);
  db.close();
});
it("records real attempt latency/status/retry counts but not keys, bodies or cached duplicates", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
  const { db, recorder } = setup();
  recorder.begin(start);
  const a = new ApiAccess();
  a.onAttempt = (e) => recorder.attempt(e);
  let n = 0;
  const fn = vi.fn(async () => {
    if (n++ === 0) throw Error("UPSTREAM_HTTP_503");
    return 7;
  });
  const p = a.run("DeepBook Indexer", "SECRET_KEY", fn, 1000, {
    maxTransientRetries: 2,
  });
  const duplicate = a.run("DeepBook Indexer", "SECRET_KEY", fn, 1000, {
    maxTransientRetries: 2,
  });
  await vi.runAllTimersAsync();
  expect(await p).toBe(7);
  expect(await duplicate).toBe(7);
  expect(await a.run("DeepBook Indexer", "SECRET_KEY", fn, 1000)).toBe(7);
  const r = recorder.report(Date.now(), true);
  expect(r.apis?.[0]).toMatchObject({
    requests: 2,
    retries: 1,
    codes: { UPSTREAM_HTTP_503: 1 },
  });
  expect(JSON.stringify(r)).not.toContain("SECRET_KEY");
  db.close();
});
it("does not retry a successful request when metrics persistence fails", async () => {
  const a = new ApiAccess(),
    fn = vi.fn(async () => 42);
  a.onAttempt = () => {
    throw Error("SQLITE_FULL");
  };
  await expect(
    a.run("DeepBook Indexer", "x", fn, 0, { maxTransientRetries: 2 }),
  ).rejects.toThrow("VALIDATION_RECORD_FAILED");
  expect(fn).toHaveBeenCalledTimes(1);
});
for (const code of [
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_CONNECT_TIMEOUT",
  "UPSTREAM_HEADERS_TIMEOUT",
  "UPSTREAM_BODY_TIMEOUT",
  "UPSTREAM_HTTP_429",
  "UPSTREAM_HTTP_502",
  "UPSTREAM_HTTP_503",
  "UPSTREAM_HTTP_504",
])
  it(
    "retains API failure and immediate safety-stop evidence for " + code,
    () => {
      const { db, monitor, recorder } = setup();
      recorder.begin(start);
      recorder.attempt({
        api: "DeepBook Indexer",
        success: false,
        code,
        latencyMs: 8000,
        attempt: 0,
        occurredAt: start + 8000,
      });
      monitor.stop(code, start + 8001);
      const r = recorder.report(start + 9000, true);
      expect(r.apis?.[0].codes[code]).toBe(1);
      expect(r.paper?.safetyStops).toHaveLength(1);
      expect(r.paper?.missingSafetyStops).toBe(0);
      db.close();
    },
  );
for (const code of ["INDEXER_DELAYED", "CANDLE_GAP", "UPSTREAM_TIMEOUT"])
  it(
    "records " + code + " and keeps PAPER stopped after recovery",
    async () => {
      const { db, monitor, recorder } = setup();
      recorder.begin(Date.now());
      let fail = true;
      const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
      const e = new BotEngine(
        db,
        {
          candles: async (tf) => {
            if (fail) throw Error(code);
            return bars(tf, Date.now());
          },
          status: () => market(Date.now()),
        },
        {
          getQuote: async () => {
            throw Error("UNEXPECTED_ORDER");
          },
          validateQuote: async () => false,
        },
        { health: async () => health, status: health },
      );
      e.validation = recorder;
      db.set("runtime", { ...db.runtime(), running: true });
      monitor.transition("MANUAL_START");
      await e.tick();
      expect(db.runtime()).toMatchObject({ running: false, error: code });
      fail = false;
      await e.tick();
      expect(db.runtime().running).toBe(false);
      expect(db.history("paper_trades")).toHaveLength(0);
      expect(
        recorder.report(Date.now(), true).paper?.safetyStops.length,
      ).toBeGreaterThan(0);
      db.close();
    },
  );
it("refuses LIVE, fallback providers and production database in validation profile", () => {
  const env = {
    DEEPBOOK_VALIDATION: "1",
    MODE: "PAPER",
    MARKET_DATA_PROVIDER: "deepbook",
    DEEPBOOK_RECONSTRUCT_CANDLES: "verified",
    DATABASE_PATH: "/app/validation/deepbook-paper.sqlite",
  };
  expect(assertValidationProfile(env)).toBe(true);
  for (const extra of [
    { MODE: "LIVE" },
    { MARKET_DATA_PROVIDER: "auto" },
    { DEEPBOOK_RECONSTRUCT_CANDLES: "off" },
    { DATABASE_PATH: "/app/data/bot.sqlite" },
  ])
    expect(() => assertValidationProfile({ ...env, ...extra })).toThrow(
      "INVALID_VALIDATION_PROFILE",
    );
  expect(assertValidationProfile({})).toBe(false);
});
it("exports atomic UTF-8 JSON and Japanese Markdown reports", () => {
  const { db, recorder } = setup();
  recorder.begin(start);
  const d = mkdtempSync(join(tmpdir(), "suiba-report-"));
  dirs.push(d);
  const r = recorder.report(start + 1000, true);
  exportValidationReport(d, r);
  expect(JSON.parse(readFileSync(join(d, "latest.json"), "utf8")).status).toBe(
    "検証途中",
  );
  expect(readFileSync(join(d, "latest.md"), "utf8")).toContain("検証途中");
  expect(existsSync(join(d, "latest.json.tmp"))).toBe(false);
  db.close();
});
it("rejects missing, stale-book and malformed-price fill evidence in reports", () => {
  const { db, recorder } = setup();
  recorder.begin(start);
  db.set("runtime", { ...db.runtime(), running: true });
  const m = market(start);
  m.bookAt = start - 10001;
  const f = recorder.fill(
    m,
    bars()[0].source,
    bars(),
    start + 10000,
    true,
    true,
    start,
  )!;
  f.candles[0].close = -1;
  db.append("validation_events", "fill", f, start);
  db.append("paper_trades", "trade", {}, start);
  const r = recorder.report(start + 1000, true);
  expect(r.paper?.unsafeFills).toBe(1);
  expect(r.criteria?.find((c) => c.name.startsWith("PAPER約定"))?.ok).toBe(
    false,
  );
  db.close();
});
it("detects unauthorized resume after a persisted safe stop", () => {
  const { db, monitor, recorder } = setup();
  recorder.begin(start);
  db.set("runtime", { ...db.runtime(), running: true });
  monitor.transition("MANUAL_START", start + 1);
  monitor.stop("UPSTREAM_TIMEOUT", start + 1000);
  db.set("runtime", { ...db.runtime(), running: true, error: null });
  recorder.sample(market(start + 15000), start + 15000);
  expect(recorder.report(start + 15000, true).paper?.unauthorizedRuns).toBe(1);
  db.close();
});

it("does not demand duplicate STOP events during retries of an already stopped Bot", () => {
  const { db, monitor, recorder } = setup();
  recorder.begin(start);
  recorder.attempt({
    api: "DeepBook Indexer",
    success: false,
    code: "UPSTREAM_HTTP_503",
    latencyMs: 1,
    attempt: 0,
    occurredAt: start + 1,
  });
  monitor.stop("UPSTREAM_HTTP_503", start + 2);
  recorder.attempt({
    api: "DeepBook Indexer",
    success: false,
    code: "UPSTREAM_HTTP_503",
    latencyMs: 1,
    attempt: 1,
    occurredAt: start + 2000,
  });
  const r = recorder.report(start + 2001, true);
  expect(r.paper?.missingSafetyStops).toBe(0);
  expect(r.paper?.safetyStops).toHaveLength(1);
  db.close();
});

it("recognizes a later original candle backfill without claiming reconstruction", () => {
  const { db, recorder } = setup();
  recorder.begin(start);
  const m = market(),
    t = bars()[20].timestamp;
  Object.assign(m.quality![300], {
    gapTimestamps: [t],
    missing: 1,
    unresolved: 1,
  });
  recorder.cycle(m, {}, null, "CANDLE_GAP", start, start + 1);
  recorder.cycle(market(), { 300: bars() }, "WAIT", null, start, start + 2);
  const r = recorder.report(start + 2, true);
  expect(r.candles).toMatchObject({
    originalMissing: 1,
    reconstructed: 0,
    restoredOriginal: 1,
    unresolved: 0,
  });
  db.close();
});
it("keeps helper initialization idempotent without reading or editing production env", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-init-"));
  dirs.push(dir);
  mkdirSync(join(dir, "docker"));
  copyFileSync("docker/deepbook-24h.mjs", join(dir, "docker/deepbook-24h.mjs"));
  copyFileSync(
    "docker/deepbook-24h.env.example",
    join(dir, "docker/deepbook-24h.env.example"),
  );
  writeFileSync(join(dir, ".env"), "DO_NOT_TOUCH=production-test-sentinel");
  const run = () =>
    execFileSync(
      process.execPath,
      [join(dir, "docker/deepbook-24h.mjs"), "init"],
      { encoding: "utf8", windowsHide: true },
    );
  run();
  const secret = readFileSync(
    join(dir, "docker/secrets/deepbook-24h-admin.txt"),
    "utf8",
  );
  expect(secret).toHaveLength(64);
  writeFileSync(join(dir, "docker/.env.deepbook-24h"), "VALIDATION_PORT=3102");
  const output = run();
  expect(output).not.toContain(secret);
  expect(
    readFileSync(join(dir, "docker/secrets/deepbook-24h-admin.txt"), "utf8"),
  ).toBe(secret);
  expect(readFileSync(join(dir, "docker/.env.deepbook-24h"), "utf8")).toBe(
    "VALIDATION_PORT=3102",
  );
  expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
    "DO_NOT_TOUCH=production-test-sentinel",
  );
});
it("rolls back PAPER order and trade when atomic validation evidence cannot be saved", () => {
  const { db } = setup();
  db.set("runtime", { ...db.runtime(), running: true });
  const append = db.append.bind(db),
    spy = vi.spyOn(db, "append").mockImplementation((...args) => {
      if (args[0] === "validation_events") throw Error("SQLITE_FULL");
      return append(...args);
    });
  expect(() =>
    db.commitFill(
      "test",
      {},
      db.portfolio(),
      { timestamp: start } as any,
      db.runtime(),
      {
        audit: {} as any,
        check: { ok: true } as any,
        markPrice: 2,
        validation: { kind: "fill" },
      },
    ),
  ).toThrow("SQLITE_FULL");
  spy.mockRestore();
  expect(db.history("paper_orders")).toHaveLength(0);
  expect(db.history("paper_trades")).toHaveLength(0);
  expect(db.runtime().running).toBe(true);
  db.close();
});

for (const error of [Error("UPSTREAM_TIMEOUT"), new RateLimited("0")])
  it(
    "runs immediate safety callback before persistence for " + error.message,
    async () => {
      const a = new ApiAccess(),
        seen: string[] = [];
      a.onTransientFailure = () => {
        seen.push("stop");
      };
      a.onRateLimit = () => {
        seen.push("stop");
      };
      a.onAttempt = () => {
        seen.push("record");
        throw Error("SQLITE_FULL");
      };
      await expect(
        a.run("DeepBook Indexer", "x", async () => {
          throw error;
        }),
      ).rejects.toThrow("VALIDATION_RECORD_FAILED");
      expect(seen).toEqual(["stop", "record"]);
    },
  );

it("continues records after an unclean restart but cannot pass integrity", () => {
  const { db, recorder } = setup();
  recorder.boot();
  recorder.begin(start);
  const reboot = new ValidationRecorder(db);
  reboot.boot();
  const r = reboot.report(start + 86400000, true);
  expect(r.integrityFault).toBe("UNCLEAN_RESTART");
  expect(r.criteria?.[0].ok).toBe(false);
  expect(r.status).not.toBe("合格");
  expect(reboot.session()?.id).toBe(recorder.session()?.id);
  db.close();
});
it("clean shutdown keeps the same measurement session without an integrity fault", () => {
  const { db, recorder } = setup();
  recorder.boot();
  recorder.begin(start);
  recorder.closed();
  const reboot = new ValidationRecorder(db);
  reboot.boot();
  expect(reboot.report(start + 1000, true).integrityFault).toBeNull();
  db.close();
});

it("initializes a separate P0 profile without replacing the existing test credentials or env", () => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-init-"));
  dirs.push(dir);
  mkdirSync(join(dir, "docker"));
  copyFileSync("docker/deepbook-24h.mjs", join(dir, "docker/deepbook-24h.mjs"));
  copyFileSync(
    "docker/deepbook-24h.env.example",
    join(dir, "docker/deepbook-24h.env.example"),
  );
  const run = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [join(dir, "docker/deepbook-24h.mjs"), "init", ...args],
      { encoding: "utf8", windowsHide: true },
    );
  run();
  const secret = readFileSync(
      join(dir, "docker/secrets/deepbook-24h-admin.txt"),
      "utf8",
    ),
    env = readFileSync(join(dir, "docker/.env.deepbook-24h"), "utf8");
  run("--profile=p0");
  expect(readFileSync(join(dir, "docker/.env.deepbook-p0"), "utf8")).toContain(
    "VALIDATION_PORT=3102",
  );
  expect(
    readFileSync(join(dir, "docker/secrets/deepbook-p0-admin.txt"), "utf8"),
  ).not.toBe(secret);
  expect(
    readFileSync(join(dir, "docker/secrets/deepbook-24h-admin.txt"), "utf8"),
  ).toBe(secret);
  expect(readFileSync(join(dir, "docker/.env.deepbook-24h"), "utf8")).toBe(env);
});
