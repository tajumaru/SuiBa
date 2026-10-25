const { test } = require("node:test");
const assert = require("node:assert/strict");
const { summarize } = require("../scripts/summarize-preflight.cjs");
const { captureEndBook } = require("../scripts/preflight-end-book.cjs");

function fixture() {
  const start = 1800000000000,
    end = start + 7200000;
  const context = {
    schemaVersion: 1,
    runId: "fixture-run",
    project: "fixture-project",
    sha: "fixture-sha",
    imageId: "sha256:fixture",
    durationMinutes: 120,
    measurementMode: "passive-health-cache-v1",
    perfDetailEnabled: true,
    reason: "COMPLETED",
  };
  const build = { declaredSha: context.sha, declaredImage: context.imageId };
  const market = {
    bookAt: end - 1000,
    diagnostics: { indexerLagMs: 1000 },
    quality: {},
  };
  const frames = {};
  for (const tf of [300, 900, 3600]) {
    frames[tf] = {
      count: 61,
      timestamps: Array.from(
        { length: 61 },
        (_, i) => end / 1000 - tf * (61 - i),
      ),
      repairs: [],
    };
    market.quality[tf] = {
      fetchedAt: end - 500,
      unresolved: 0,
      reconstructionMs: 1,
      gapTimestamps: [],
    };
  }
  const sample = (at) => ({
    kind: "sample",
    at,
    runtime: { running: false },
    safety: { resumePending: false },
    counts: {
      paper_orders: 0,
      paper_trades: 0,
      paper_checks: 0,
      operation_candidates: 0,
    },
    build,
    settingsSha256: "settings",
    integrity: [{ integrity_check: "ok" }],
    integrityFault: null,
    validationSession: null,
    profitGuard: true,
    portfolio: {},
    market,
  });
  const observer = {
    kind: "observer",
    at: start - 1,
    ...context,
    image: context.imageId,
  };
  const rows = [
    observer,
    ...Array.from({ length: 481 }, (_, i) => sample(start + i * 15000)),
  ];
  for (const api of ["Sui gRPC", "DeepBook Indexer"])
    for (let i = 0; i < 100; i++)
      rows.push({
        kind: "api",
        at: start + i + 1000,
        data: {
          api,
          success: true,
          occurredAt: start + i + 1000,
          latencyMs: 50,
          attempt: 0,
        },
      });
  const cycle = {
    kind: "cycle",
    at: end,
    began: end - 1000,
    durationMs: 1000,
    error: null,
    action: "WAIT",
    frames,
    market,
    execution: { cycleId: "cycle-1" },
  };
  rows.push(cycle);
  const audit = {
    at: end,
    runIdentity: { ...context },
    terminalSample: sample(end),
    finalBook: {
      timestamp: end - 1000,
      startedAt: end - 500,
      completedAt: end - 100,
      durationMs: 400,
      source: "DeepBook:SUI_USDC",
      error: null,
    },
    cycles: [
      { phase: "START", beganAt: end - 1000, cycleId: "cycle-1" },
      { phase: "END", endedAt: end, cycleId: "cycle-1" },
    ],
    events: [],
    candles: [],
    runtime: { running: false },
    build,
    settingsSha256: "settings",
    tables: { ...sample(end).counts, bot_settings: 0 },
    integrity: [{ integrity_check: "ok" }],
    operations: { ledger: { ok: true } },
  };
  return {
    rows,
    audit,
    inspection: {
      Image: context.imageId,
      RestartCount: 0,
      Project: context.project,
    },
    context,
  };
}
function result(f) {
  return summarize(f.rows, f.audit, f.inspection, f.context);
}

test("two hours and all evidence yield GO without changing fixed thresholds", () => {
  const r = result(fixture());
  assert.equal(r.verdict, "GO");
  assert.equal(r.durationMs, 7200000);
  assert.deepEqual(r.limits, {
    durationMs: 7200000,
    minAttempts: 100,
    bookAgeMs: 10000,
  });
});
test("terminal audit can prove the boundary missing from periodic heartbeats", () => {
  const f = fixture();
  f.rows = f.rows.filter((r) => r.kind !== "sample" || r.at < f.audit.at);
  assert.equal(result(f).checks.twoHours, true);
  assert.equal(result(f).window.source, "terminal-audit");
});
test("less than two hours is insufficient, never rounded to GO", () => {
  const f = fixture();
  f.rows.find((r) => r.kind === "sample").at += 484;
  assert.equal(result(f).durationMs, 7199516);
  assert.equal(result(f).verdict, "INCONCLUSIVE");
});
test("82 Sui attempts stay 82; cached cycle success is never an HTTP attempt", () => {
  const f = fixture();
  let count = 0;
  f.rows = f.rows.filter(
    (r) => r.kind !== "api" || r.data.api !== "Sui gRPC" || ++count <= 82,
  );
  const r = result(f);
  assert.equal(r.apis["Sui gRPC"].attempts, 82);
  assert.equal(r.criteria.suiMinAttempts.threshold, 100);
  assert.equal(r.verdict, "INCONCLUSIVE");
});
test("missing final book is unknown; stale or future book is a hard failure", () => {
  for (const timestamp of [null, 1800007200000 - 10001, 1800007200000 + 1]) {
    const f = fixture();
    f.audit.finalBook.timestamp = timestamp;
    const r = result(f);
    assert.equal(r.verdict, timestamp === null ? "INCONCLUSIVE" : "NO-GO");
    assert.equal(r.checks.bookFreshAtEnd, timestamp === null ? null : false);
  }
});
test("insufficient attempts cannot mask a known freshness or safety failure", () => {
  const f = fixture();
  f.rows = f.rows.filter((r) => r.kind !== "api" || r.data.api !== "Sui gRPC");
  f.audit.finalBook.timestamp -= 10001;
  assert.equal(result(f).verdict, "NO-GO");
  f.audit.finalBook.timestamp += 10001;
  f.audit.runtime.running = true;
  assert.equal(result(f).verdict, "NO-GO");
});
test("identity mismatches reject another run, SHA, image, duration or measurement mode", () => {
  for (const key of [
    "runId",
    "sha",
    "imageId",
    "durationMinutes",
    "measurementMode",
    "perfDetailEnabled",
    "project",
  ]) {
    const f = fixture();
    f.audit.runIdentity[key] = "wrong";
    assert.equal(result(f).verdict, "NO-GO", key);
  }
});
test("legacy evidence cannot invent run identity or terminal observations", () => {
  const f = fixture();
  f.context = null;
  const r = result(f);
  assert.equal(r.checks.runIdentity, null);
  assert.equal(r.verdict, "INCONCLUSIVE");
  assert.equal(r.window.source, "legacy-heartbeat");
});
test("missing audit evidence reports incomplete rather than crashing", () => {
  const f = fixture();
  delete f.audit.cycles;
  assert.equal(result(f).verdict, "INCONCLUSIVE");
});
test("communication and cycle failures still prohibit GO", () => {
  const f = fixture();
  for (const r of f.rows
    .filter((r) => r.kind === "api" && r.data.api === "Sui gRPC")
    .slice(0, 3))
    r.data.success = false;
  assert.equal(result(f).verdict, "NO-GO");
  const g = fixture();
  g.rows.find((r) => r.kind === "cycle").error = "SUI_READ_FAILED";
  assert.equal(result(g).verdict, "NO-GO");
});
test("end probe is GET-only, bounded, preserves upstream timestamp, and never retries", async () => {
  let calls = 0;
  const result = await captureEndBook(
    async (url, init) => {
      calls++;
      assert.match(url, /\/orderbook\/SUI_USDC\?level=2&depth=10$/);
      assert.equal(init.method, undefined);
      assert.ok(init.signal);
      return new Response(
        JSON.stringify({
          timestamp: 123,
          bids: [["1", "2"]],
          asks: [["2", "3"]],
        }),
      );
    },
    () => 999,
  );
  assert.equal(calls, 1);
  assert.equal(result.timestamp, 123); // Never substitute Date.now for upstream book time.
});
test("end probe missing, malformed and failed responses stay unknown", async () => {
  for (const transport of [
    async () => {
      throw Error("timeout");
    },
    async () => new Response("{}"),
    async () => new Response("", { status: 503 }),
  ]) {
    assert.equal((await captureEndBook(transport)).timestamp, null);
  }
});

test("missing end snapshot or incomplete identity cannot be GO", () => {
  const f = fixture();
  delete f.audit.terminalSample;
  assert.equal(result(f).checks.terminalEvidence, null);
  assert.equal(result(f).verdict, "INCONCLUSIVE");
  const g = fixture();
  delete g.audit.runIdentity.measurementMode;
  assert.equal(result(g).checks.runIdentity, null);
  assert.equal(result(g).verdict, "INCONCLUSIVE");
});
test("end probe evidence must be from this audit window", () => {
  const f = fixture();
  f.audit.finalBook.completedAt = f.audit.at + 1;
  assert.equal(result(f).checks.bookFreshAtEnd, false);
  assert.equal(result(f).checks.endBookTiming, false);
  assert.equal(result(f).verdict, "NO-GO");
});

test("read-only audit persists terminal evidence only on normal completion", () => {
  const { DatabaseSync } = require("node:sqlite");
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawnSync } = require("node:child_process");
  const dir = fs.mkdtempSync(
    path.join(require("node:os").tmpdir(), "quality-audit-test-"),
  );
  try {
    const file = path.join(dir, "fixture.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE bot_runtime_state (key TEXT, json TEXT)");
    const values = {
      runtime: { running: false },
      paper_safety: { resumePending: false },
      operation_state: {},
      runtime_build: { declaredSha: "fixture" },
      settings: { profitGuardEnabled: true, intervalMs: 60000 },
      validation_session: null,
      portfolio: {},
      validation_integrity_fault: null,
      market_quality: {},
    };
    for (const [key, value] of Object.entries(values))
      db.prepare("INSERT INTO bot_runtime_state VALUES (?, ?)").run(
        key,
        JSON.stringify(value),
      );
    for (const table of [
      "cycle_audits",
      "operation_events",
      "paper_orders",
      "paper_trades",
      "paper_checks",
      "operation_candidates",
      "bot_settings",
      "strategy_decisions",
      "risk_events",
      "validation_events",
      "market_candles",
    ])
      db.exec(
        `CREATE TABLE ${table} (timestamp INTEGER, timeframe INTEGER, source TEXT, json TEXT)`,
      );
    db.close();
    const token = path.join(dir, "fixture-token.txt");
    fs.writeFileSync(token, "test-fixture");
    const mock = `globalThis.fetch = async (url) => {
      if (String(url) === 'http://127.0.0.1:3100/api/operations') return new Response(JSON.stringify({accounting:{ledger:{ok:true}}}));
      if (String(url).endsWith('/orderbook/SUI_USDC?level=2&depth=10')) {
        if (!process.argv.includes('--end-book')) throw Error('UNEXPECTED_UPSTREAM_READ');
        return new Response(JSON.stringify({timestamp:Date.now(),bids:[['1','2']],asks:[['2','3']]}));
      }
      throw Error('UNEXPECTED_NETWORK');
    };`;
    for (const complete of [false, true]) {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "data:text/javascript," + encodeURIComponent(mock),
          path.join(__dirname, "../scripts/preflight-audit.cjs"),
          ...(complete ? ["--end-book"] : []),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            DATABASE_PATH: file,
            ADMIN_TOKEN_FILE: token,
            SUIBA_WINVERIFY_RUN_ID: "fixture-run",
            SUIBA_PREFLIGHT_PROJECT: "fixture-project",
            SUIBA_BUILD_SHA: "fixture",
            SUIBA_IMAGE_ID: "sha256:fixture",
            SUIBA_WINVERIFY_DURATION_MINUTES: "120",
            SUIBA_PREFLIGHT_MEASUREMENT_MODE: "passive-health-cache-v1",
            SUIBA_PERF_DETAIL: "1",
          },
        },
      );
      assert.equal(child.status, 0, child.stderr);
      const audit = JSON.parse(child.stdout);
      assert.equal(!!audit.terminalSample, complete);
      assert.equal(audit.runIdentity.runId, "fixture-run");
      if (complete) {
        assert.equal(audit.terminalSample.at, audit.at);
        assert.equal(audit.finalBook.error, null);
        assert.equal(audit.terminalSample.runtime.running, false);
        assert.equal(audit.terminalSample.counts.paper_orders, 0);
      }
    }
  } finally {
    assert.ok(
      path
        .resolve(dir)
        .startsWith(path.resolve(require("node:os").tmpdir()) + path.sep),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a longer planned run cannot pass using only a two-hour window", () => {
  const f = fixture();
  f.context.durationMinutes = f.audit.runIdentity.durationMinutes = 360;
  f.rows.find((r) => r.kind === "observer").durationMinutes = 360;
  assert.equal(result(f).checks.twoHours, true);
  assert.equal(result(f).checks.plannedDuration, false);
  assert.equal(result(f).verdict, "INCONCLUSIVE");
});

test("missing safety or ledger inputs are incomplete; observed running still fails", () => {
  const f = fixture();
  delete f.rows.find((r) => r.kind === "sample").safety;
  assert.equal(result(f).verdict, "INCONCLUSIVE");
  f.audit.runtime.running = true;
  assert.equal(result(f).verdict, "NO-GO");
  const g = fixture();
  delete g.audit.operations.ledger;
  assert.equal(result(g).verdict, "INCONCLUSIVE");
});

function fakeClock(...values) {
  return () => {
    assert.ok(values.length, "unexpected clock read");
    return values.shift();
  };
}
function bookResponse(timestamp) {
  return new Response(
    JSON.stringify({ timestamp, bids: [["1", "2"]], asks: [["2", "3"]] }),
  );
}

test("upstream time may advance during acquisition, but must not exceed completion", async () => {
  for (const offset of [-600, -300, -100, -50]) {
    const f = fixture(),
      end = f.audit.at;
    f.audit.finalBook = await captureEndBook(
      async () => bookResponse(end + offset),
      fakeClock(end - 500, end - 100),
      fakeClock(0, 400),
    );
    assert.equal(f.audit.finalBook.timestamp, end + offset);
    assert.equal(
      f.audit.finalBook.error,
      offset > -100 ? "END_BOOK_FUTURE_TIMESTAMP" : null,
    );
    assert.equal(result(f).verdict, offset > -100 ? "NO-GO" : "GO");
    // The invalid timestamp is earlier than audit.at; an audit-only future check misses it.
    assert.ok(f.audit.finalBook.timestamp <= f.audit.at);
  }
});

test("collector rejects wall-clock and monotonic reversals without clamping them", async () => {
  for (const [wall, mono] of [
    [
      [10000, 9999],
      [0, 100],
    ],
    [
      [10000, 10100],
      [100, 99],
    ],
  ]) {
    const book = await captureEndBook(
      async () => bookResponse(9990),
      fakeClock(...wall),
      fakeClock(...mono),
    );
    assert.equal(book.error, "END_BOOK_TIME_REVERSED");
    const f = fixture();
    f.audit.finalBook = book;
    assert.equal(result(f).checks.endBookTiming, false);
    assert.equal(result(f).verdict, "NO-GO");
  }
});

test("a late successful response cannot become proof, even when the wall clock hides the delay", async () => {
  for (const [wallMs, monoMs] of [
    [8001, 8001],
    [8001, 100],
    [100, 8001],
  ]) {
    const f = fixture(),
      end = f.audit.at;
    f.audit.finalBook = await captureEndBook(
      async () => bookResponse(end - 200),
      fakeClock(end - 100 - wallMs, end - 100),
      fakeClock(0, monoMs),
    );
    assert.equal(f.audit.finalBook.error, "END_BOOK_TIMEOUT");
    assert.equal(result(f).verdict, "NO-GO");
  }
});

test("a delayed body is included in acquisition time", async () => {
  const f = fixture(),
    end = f.audit.at;
  let mono = 0;
  f.audit.finalBook = await captureEndBook(
    async () => ({
      ok: true,
      json: async () => {
        mono = 8001;
        return { timestamp: end - 200, bids: [["1", "2"]], asks: [["2", "3"]] };
      },
    }),
    fakeClock(end - 500, end - 100),
    () => mono,
  );
  assert.equal(f.audit.finalBook.durationMs, 8001);
  assert.equal(f.audit.finalBook.error, "END_BOOK_TIMEOUT");
  assert.equal(result(f).verdict, "NO-GO");
});

test("acquisition and freshness thresholds remain exactly eight and ten seconds", async () => {
  for (const [duration, age, expected] of [
    [8000, 10000, "GO"],
    [8001, 10000, "NO-GO"],
    [8000, 10001, "NO-GO"],
  ]) {
    const f = fixture(),
      end = f.audit.at;
    f.audit.finalBook = await captureEndBook(
      async () => bookResponse(end - age),
      fakeClock(end - duration, end),
      fakeClock(0, duration),
    );
    assert.equal(result(f).verdict, expected);
    assert.equal(result(f).limits.minAttempts, 100);
    assert.equal(result(f).limits.bookAgeMs, 10000);
  }
});

test("time reversal and acquisition outside the observation window prohibit GO", () => {
  for (const change of [
    (f) => {
      f.audit.finalBook.completedAt = f.audit.finalBook.startedAt - 1;
    },
    (f) => {
      f.audit.finalBook.startedAt =
        f.rows.find((r) => r.kind === "sample").at - 1;
    },
    (f) => {
      f.audit.finalBook.completedAt = f.audit.at + 1;
    },
    (f) => {
      f.audit.finalBook.durationMs = -1;
    },
    (f) => {
      f.audit.at = f.rows.find((r) => r.kind === "sample").at - 1;
      f.audit.terminalSample.at = f.audit.at;
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(result(f).verdict, "NO-GO");
    assert.equal(result(f).checks.endBookTiming, false);
  }
});

test("delay after completion is evaluated at audit time, not at request completion", () => {
  for (const [age, expected] of [
    [10000, "GO"],
    [10001, "NO-GO"],
  ]) {
    const f = fixture(),
      end = f.audit.at;
    f.audit.finalBook = {
      ...f.audit.finalBook,
      startedAt: end - age - 100,
      completedAt: end - age,
      durationMs: 100,
      timestamp: end - age,
    };
    assert.equal(result(f).verdict, expected);
  }
});

test("transport, HTTP, body and schema failures cannot use the worker's cached book as fallback", async () => {
  for (const transport of [
    async () => {
      throw Error("network failed");
    },
    async () => new Response("", { status: 503 }),
    async () => ({
      ok: true,
      json: async () => {
        throw Error("body failed");
      },
    }),
    async () => new Response("{}"),
  ]) {
    const f = fixture(),
      end = f.audit.at;
    f.audit.finalBook = await captureEndBook(
      transport,
      fakeClock(end - 500, end - 100),
      fakeClock(0, 400),
    );
    assert.equal(f.audit.finalBook.timestamp, null);
    assert.equal(result(f).checks.bookFreshAtEnd, null);
    assert.equal(result(f).verdict, "INCONCLUSIVE");
  }
});

test("missing or non-finite timing evidence is incomplete rather than a zero-duration success", () => {
  for (const key of [
    "startedAt",
    "completedAt",
    "durationMs",
    "timestamp",
    "source",
    "error",
  ]) {
    const f = fixture();
    delete f.audit.finalBook[key];
    assert.equal(result(f).verdict, "INCONCLUSIVE", key);
  }
  for (const value of [null, NaN, Infinity]) {
    const f = fixture();
    f.audit.finalBook.durationMs = value;
    assert.equal(result(f).checks.endBookTiming, null);
    assert.equal(result(f).verdict, "INCONCLUSIVE");
  }
  const f = fixture();
  delete f.audit.finalBook;
  assert.equal(result(f).verdict, "INCONCLUSIVE");
  const g = fixture();
  delete g.audit.at;
  assert.equal(result(g).verdict, "INCONCLUSIVE");
});
