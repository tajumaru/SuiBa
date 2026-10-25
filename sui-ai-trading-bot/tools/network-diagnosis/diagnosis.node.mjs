import "./clock.node.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import {
  LIMITS,
  SUI,
  DEEP,
  RPC_PATH,
  BOOK_PATH,
  plan,
  assertNode,
  authorize,
  argsOf,
  guardRequest,
  times,
  cycleStop,
  safeCode,
  writer,
} from "./core.mjs";
import {
  buffered,
  h2Transport,
  sdkClient,
  metadata,
  controlledAgentOptions,
  CONTROLLED_POOL,
} from "./transports.mjs";
import { parse, summarize, csv, generate } from "./report.mjs";
const tool = fileURLToPath(new URL(".", import.meta.url));
const temp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), "suiba-netdiag-test-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
};

test("default CLI and Windows wrapper do not execute network or resolve Node/Docker", () => {
  const guard = `import net from 'node:net';import dns from 'node:dns';import tls from 'node:tls';import http2 from 'node:http2';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
    const forbidden=()=>{throw Error('NETWORK_FORBIDDEN_DURING_TEST');};globalThis.fetch=forbidden;
    net.connect=net.createConnection=dns.lookup=dns.resolve=dns.promises.lookup=tls.connect=http2.connect=http.request=https.request=forbidden;syncBuiltinESMExports();`;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "data:text/javascript," + encodeURIComponent(guard),
      join(tool, "cli.mjs"),
    ],
    { encoding: "utf8", env: { ...process.env, CI: "true" } },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).networkRequests, 0);
  assert.equal(authorize({}), false);
  assert.throws(
    () => authorize({ executeLive: true }, { CI: "true" }),
    /FORBIDDEN_IN_CI/,
  );
  if (process.platform === "win32") {
    for (const shell of ["powershell.exe", "pwsh"]) {
      const ps = spawnSync(
        shell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(tool, "Invoke-NetworkDiagnosis.ps1"),
          "-NodePath",
          "Z:/missing-node.exe",
        ],
        { encoding: "utf8" },
      );
      assert.equal(ps.status, 0, ps.stdout + ps.stderr);
      assert.equal(JSON.parse(ps.stdout).networkRequests, 0);
      const blocked = spawnSync(
        shell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(tool, "Invoke-NetworkDiagnosis.ps1"),
          "-ExecuteLive",
          "-NodePath",
          "Z:/missing-node.exe",
        ],
        { encoding: "utf8", env: { ...process.env, CI: "true" } },
      );
      assert.notEqual(blocked.status, 0);
      assert.match(
        blocked.stdout + blocked.stderr,
        /Live diagnosis is forbidden in CI/,
      );
    }
    const bat = spawnSync(
      "cmd.exe",
      ["/d", "/c", "Start-SuiBaNetworkDiagnosis.bat", "--plan"],
      {
        cwd: tool,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "true",
          SUIBA_DIAGNOSTIC_NODE: "Z:/missing-node.exe",
        },
      },
    );
    assert.equal(bat.status, 0, bat.stdout + bat.stderr);
    assert.equal(JSON.parse(bat.stdout).networkRequests, 0);
    const windowsRoot = process.env.SystemRoot ?? "C:\Windows";
    const fallback = spawnSync(
      "cmd.exe",
      ["/d", "/c", "Start-SuiBaNetworkDiagnosis.bat", "--plan"],
      {
        cwd: tool,
        encoding: "utf8",
        env: {
          ...process.env,
          CI: "true",
          SUIBA_DIAGNOSTIC_NODE: "Z:/missing-node.exe",
          PATH: [
            join(windowsRoot, "System32"),
            join(windowsRoot, "System32", "WindowsPowerShell", "v1.0"),
          ].join(";"),
        },
      },
    );
    assert.equal(fallback.status, 0, fallback.stdout + fallback.stderr);
    assert.equal(JSON.parse(fallback.stdout).networkRequests, 0);
  }
});
test("supported Node range and explicit arguments", () => {
  for (const v of ["24.22.1", "v24.22.2", "24.23.0"])
    assert.doesNotThrow(() => assertNode(v));
  for (const v of ["24.22.0", "24.14.0", "25.0.0", "22.22.1", undefined]) {
    if (v !== undefined) assert.throws(() => assertNode(v));
  }
  assert.deepEqual(argsOf(["--side", "windows", "--run-id", "netdiag-test"]), {
    side: "windows",
    runId: "netdiag-test",
  });
  assert.throws(() => argsOf(["--side"]));
  assert.throws(() => argsOf(["--url", "https://example.org"]));
  assert.equal(plan().qualityVerdict, "NOT_EVALUATED");
});
test("only fixed read-only requests allowed; transactions and arbitrary destinations rejected", () => {
  assert.equal(
    guardRequest({ target: "sui" }, SUI + RPC_PATH, { method: "POST" }).origin,
    SUI,
  );
  assert.doesNotThrow(() =>
    guardRequest({ target: "deepbook" }, DEEP + BOOK_PATH, {}),
  );
  for (const url of [
    SUI + "/sui.rpc.v2.TransactionExecutionService/ExecuteTransaction",
    SUI + RPC_PATH + "?x=1",
    SUI + RPC_PATH + "#x",
    "https://user:password@fullnode.mainnet.sui.io" + RPC_PATH,
    "https://example.org" + RPC_PATH,
  ])
    assert.throws(
      () => guardRequest({ target: "sui" }, url, { method: "POST" }),
      /ALLOWLIST/,
    );
  assert.throws(() =>
    guardRequest({ target: "deepbook" }, DEEP + BOOK_PATH, { method: "POST" }),
  );
});
test("phase accounting preserves missing/reused phases and partial timeouts", () => {
  const t = {
    began: 0,
    reused: false,
    connection: { id: 1, began: 1, dnsAt: 11, tcpAt: 31, tlsAt: 61 },
    sentAt: 65,
    headersAt: 100,
    bodyEnd: 120,
  };
  assert.deepEqual(
    [
      times(t, 125).dnsMs,
      times(t, 125).tcpMs,
      times(t, 125).tlsMs,
      times(t, 125).bodyMs,
    ],
    [10, 20, 30, 20],
  );
  assert.equal(times({ ...t, reused: true }, 125).dnsMs, null);
  const partial = times(
    { began: 0, reused: false, connection: { began: 1, dnsAt: 10, tcpAt: 30 } },
    10000,
  );
  assert.equal(partial.phase, "TLS");
  assert.equal(partial.tlsMs, null);
  assert.equal(partial.phaseElapsedMs, 9970);
  assert.equal(times({ began: 0 }, 10).phase, "UNKNOWN");
  assert.equal(
    times({ began: 0, connection: { began: 1, dnsAt: 10, dnsError: true } }, 20)
      .phase,
    "DNS",
  );
});
test("limits and circuit stops retain existing thresholds and rate-limit early exit", () => {
  assert.equal(LIMITS.suiMs, 10000);
  assert.equal(LIMITS.deepbookMs, 8000);
  assert.equal(LIMITS.maxFailedCycles, 3);
  assert.equal(cycleStop({ failures: 2, lastSuccessAt: 0, now: 299999 }), null);
  assert.equal(
    cycleStop({ failures: 3, lastSuccessAt: 0, now: 1 }),
    "CYCLES_FAILED_3_CONSECUTIVE",
  );
  assert.equal(
    cycleStop({ failures: 0, lastSuccessAt: 0, now: 300001 }),
    "NO_SUCCESSFUL_CYCLE_5MIN",
  );
  assert.equal(cycleStop({ status: 429 }), "RATE_LIMITED");
  assert.equal(safeCode(Error("Authorization: secret")), "UNKNOWN_FAILURE");
  assert.equal(
    safeCode(
      Error("fetch failed", {
        cause: { code: "ETIMEDOUT", message: "secret" },
      }),
    ),
    "ETIMEDOUT",
  );
});
test("bounded buffering aborts rate limits, oversized bodies, and incomplete reads", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    buffered(new Response("limited", { status: 429 }), {}, signal),
    /RATE_LIMITED/,
  );
  await assert.rejects(
    buffered(new Response(new Uint8Array(LIMITS.maxBodyBytes + 1)), {}, signal),
    /RESPONSE_LIMIT/,
  );
  const control = new AbortController();
  control.abort(Error("USER_STOP"));
  await assert.rejects(
    buffered(new Response("x"), {}, control.signal),
    /USER_STOP/,
  );
  const trace = {};
  assert.equal(
    await (await buffered(new Response("abc"), trace, signal)).text(),
    "abc",
  );
  assert.equal(trace.bytes, 3);
  assert.ok(trace.bodyEnd >= trace.headersAt);
});
test("real pinned Sui SDK performs one metadata RPC using an offline gRPC-Web fixture", async () => {
  const metadataBytes = Buffer.from([0x10, 9, 0x22, 3, 0x53, 0x55, 0x49]);
  const payload = Buffer.concat([
    Buffer.from([0x12, metadataBytes.length]),
    metadataBytes,
  ]);
  const frame = (flag, data) => {
    const head = Buffer.alloc(5);
    head[0] = flag;
    head.writeUInt32BE(data.length, 1);
    return Buffer.concat([head, data]);
  };
  const body = Buffer.concat([
    frame(0, payload),
    frame(0x80, Buffer.from("grpc-status: 0\r\n")),
  ]).toString("base64");
  let calls = 0;
  const client = await sdkClient(async (input, init) => {
    calls++;
    guardRequest({ target: "sui" }, input, init);
    return new Response(body, {
      headers: { "content-type": "application/grpc-web-text+proto" },
    });
  });
  await metadata(client, new AbortController().signal);
  assert.equal(calls, 1);
  let failedCalls = 0;
  const failed = await sdkClient(async () => {
    failedCalls++;
    throw Error("ETIMEDOUT");
  });
  await assert.rejects(metadata(failed, new AbortController().signal));
  assert.equal(failedCalls, 1);
});

function fakeSession() {
  const session = new EventEmitter();
  session.socket = new EventEmitter();
  session.socket.remoteFamily = "IPv4";
  session.alpnProtocol = "h2";
  session.destroy = () => {
    session.destroyed = true;
    session.emit("close");
  };
  session.close = session.destroy;
  session.request = () => {
    const stream = new EventEmitter();
    stream.rstCode = 0;
    stream.close = () => stream.emit("close");
    stream.end = () =>
      queueMicrotask(() => {
        stream.emit("ready");
        stream.emit("finish");
        stream.emit("response", {
          ":status": 200,
          "content-type": "application/json",
        });
        stream.emit("data", Buffer.from("{}"));
        stream.emit("end");
      });
    return stream;
  };
  queueMicrotask(() => {
    session.socket.emit("lookup", null);
    session.socket.emit("connect");
    session.emit("connect");
  });
  return session;
}
test("HTTP/2 reuse is measured; GOAWAY opens a fresh connection; cancellation destroys owned session", async () => {
  const observer = { serial: 0 };
  let opens = 0,
    last;
  const transport = h2Transport(
    { target: "deepbook", family: 4 },
    observer,
    () => {
      opens++;
      return (last = fakeSession());
    },
  );
  const init = { signal: new AbortController().signal };
  const a = { began: performance.now() },
    b = { began: performance.now() },
    c = { began: performance.now() };
  await transport.fetch(DEEP + BOOK_PATH, init, a);
  // Reused stream: ready already happened synchronously in request(), before return.
  const originalRequest = last.request;
  last.request = () => {
    const stream = originalRequest();
    stream.id = 3;
    return stream;
  };
  await transport.fetch(DEEP + BOOK_PATH, init, b);
  assert.ok(Number.isFinite(b.sentAt));
  assert.equal(b.sentBasis, "http2-stream-ready-and-write-finish-event");
  assert.ok(times(b).responseWaitMs >= 0);
  assert.ok(times(b).queueMs >= 0);
  last.request = () => {
    const stream = originalRequest();
    stream.id = 5;
    stream.writableFinished = true;
    return stream;
  };
  const alreadyFinished = { began: performance.now() };
  await transport.fetch(DEEP + BOOK_PATH, init, alreadyFinished);
  assert.equal(
    alreadyFinished.sentBasis,
    "http2-stream-ready-and-write-finish-state",
  );
  assert.ok(Number.isFinite(times(alreadyFinished).responseWaitMs));
  assert.equal(opens, 1);
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(a.connection.id, b.connection.id);
  last.emit("goaway");
  await transport.fetch(DEEP + BOOK_PATH, init, c);
  assert.equal(opens, 2);
  assert.equal(c.reused, false);
  transport.close();
  assert.equal(last.destroyed, true);
  const control = new AbortController();
  let stalled;
  const hang = h2Transport({ target: "deepbook", family: 4 }, observer, () => {
    stalled = fakeSession();
    stalled.request = () => {
      const s = new EventEmitter();
      s.end = () => {};
      s.close = () => {};
      return s;
    };
    return stalled;
  });
  const pending = hang.fetch(
    DEEP + BOOK_PATH,
    { signal: control.signal },
    { began: performance.now() },
  );
  control.abort(Error("REQUEST_TIMEOUT"));
  await assert.rejects(pending, /REQUEST_TIMEOUT/);
  assert.equal(stalled.destroyed, true);
});
test("append-only evidence refuses overwrite and flushes before reporting", () =>
  temp(async (dir) => {
    const emit = writer(dir, "netdiag-test", "windows");
    emit({ kind: "resource", at: 1 });
    await emit.flush();
    assert.equal(
      parse(readFileSync(join(dir, "events.jsonl"), "utf8")).rows.length,
      1,
    );
    assert.throws(
      () => writer(dir, "netdiag-test", "windows"),
      /REFUSE_OVERWRITE/,
    );
  }));

test("HTTP/2 rate-limit, truncated body, and invalid HTTP status fail without an uncaught callback error", async () => {
  for (const scenario of ["rate-limit", "truncated", "bad-status"]) {
    let session;
    const t = h2Transport(
      { target: "deepbook", family: 4 },
      { serial: 0 },
      () => {
        session = fakeSession();
        session.request = () => {
          const stream = new EventEmitter();
          stream.rstCode = 0;
          stream.close = () => stream.emit("close");
          stream.end = () =>
            queueMicrotask(() => {
              stream.emit("response", {
                ":status":
                  scenario === "rate-limit"
                    ? 429
                    : scenario === "bad-status"
                      ? 999
                      : 200,
              });
              if (scenario === "truncated") stream.emit("aborted");
              else stream.emit("end");
            });
          return stream;
        };
        return session;
      },
    );
    await assert.rejects(
      t.fetch(
        DEEP + BOOK_PATH,
        { signal: new AbortController().signal },
        { began: performance.now() },
      ),
    );
    assert.equal(session.destroyed, true);
  }
});
test("missing/truncated evidence, mismatched identity and early termination never look complete", () =>
  temp(async (dir) => {
    const m = generate(dir);
    assert.equal(m.evidenceComplete, false);
    assert.equal(m.missingFiles.length, 3);
    assert.equal(m.qualityVerdict, "NOT_EVALUATED");
    assert.equal(m.comparison[0].latencyMs.p50, null);
    const fixture = ["windows", "docker"].flatMap((side) => [
      {
        kind: "environment",
        side,
        runId: "netdiag-test",
        startAt: 100,
        endAt: 100 + LIMITS.durationMs,
        node: "v24.22.1",
        sourceHash: "same",
      },
      {
        kind: "end",
        side,
        runId: "netdiag-test",
        at: 100 + LIMITS.durationMs,
        reason: "RUN_DEADLINE",
        clock: {
          start: { wallMs: 100, monotonicMs: 200 },
          end: {
            wallMs: 100 + LIMITS.durationMs,
            monotonicMs: 200 + LIMITS.durationMs,
          },
          wallElapsedMs: LIMITS.durationMs,
          monotonicElapsedMs: LIMITS.durationMs,
          wallDriftMs: 0,
        },
      },
    ]);
    for (const side of ["windows", "docker"])
      fixture.push({
        kind: "measurement-start",
        side,
        runId: "netdiag-test",
        at: 100,
        clock: { wallMs: 100, monotonicMs: 200 },
      });
    assert.equal(
      summarize([{ rows: fixture, badLines: 0 }]).evidenceComplete,
      false,
    );
    for (const side of ["windows", "docker"]) {
      fixture.push({
        kind: "attempt",
        side,
        runId: "netdiag-test",
        success: true,
        profile: { target: "sui" },
        timing: { totalMs: 1 },
      });
      for (let slot = 0; slot < 30; slot++)
        fixture.push({ kind: "cycle", side, runId: "netdiag-test", slot });
    }
    assert.equal(
      summarize([{ rows: fixture, badLines: 0 }]).evidenceComplete,
      true,
    );
    assert.equal(
      summarize([{ rows: fixture, badLines: 1 }]).evidenceComplete,
      false,
    );
    fixture[3].reason = "USER_STOP";
    assert.equal(
      summarize([{ rows: fixture, badLines: 0 }]).evidenceComplete,
      false,
    );
    fixture[3].reason = "RUN_DEADLINE";
    fixture[2].sourceHash = "different";
    assert.equal(
      summarize([{ rows: fixture, badLines: 0 }]).identityMatched,
      false,
    );
    assert.equal(parse("{broken\n{}\n").badLines, 1);
    assert.match(
      csv([{ kind: "unavailable", code: 'quoted"value' }]),
      /quoted""value/,
    );
  }));
test("PowerShell sanitizers work offline without leaking raw log text", () => {
  if (process.platform !== "win32") return;
  for (const shell of ["powershell.exe", "pwsh"]) {
    for (const file of ["collectors.node.ps1", "windows-process.node.ps1"]) {
      const child = spawnSync(
        shell,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(tool, file),
          ...(file === "windows-process.node.ps1"
            ? ["-NodePath", process.execPath]
            : []),
        ],
        { encoding: "utf8" },
      );
      assert.equal(child.status, 0, child.stdout + child.stderr);
    }
  }
});

test("controlled keep-alive is explicit, longer than spacing, and does not change request limits", () => {
  const opts = controlledAgentOptions({ family: 4 });
  assert.equal(opts.keepAliveTimeout, 15000);
  assert.equal(opts.keepAliveMaxTimeout, 15000);
  assert.ok(
    opts.keepAliveTimeout - opts.keepAliveTimeoutThreshold > LIMITS.spacingMs,
  );
  assert.equal(CONTROLLED_POOL.serverMayShorten, true);
  assert.equal(opts.connections, 1);
  assert.equal(opts.pipelining, 1);
  assert.equal(opts.connect.family, 4);
  assert.equal(LIMITS.spacingMs, 5000);
  assert.equal(LIMITS.maxAttempts, 90);
  assert.equal(plan().measurement.nativeFetchPoolUnchanged, true);
  assert.equal(
    times({ began: 10, headersAt: 20, sentAt: 30 }, 40).responseWaitMs,
    null,
  );
});

test("warm without actual reuse stays NOT_OBSERVED, with policy and gap evidence", () => {
  const rows = [
    {
      kind: "attempt",
      side: "windows",
      profile: { target: "sui", protocol: "fetch", family: 4 },
      mode: "warm",
      success: true,
      timing: { totalMs: 200, reusedConnection: false },
      poolPolicy: CONTROLLED_POOL,
      gapSincePreviousAttemptMs: 5010,
    },
  ];
  const m = summarize([{ rows, badLines: 0 }]);
  assert.equal(m.profiles[0].reuseObservation, "NOT_OBSERVED");
  assert.equal(m.profiles[0].poolPolicy.name, "diagnostic-15s-idle");
  assert.equal(m.profiles[0].gapMs.p50, 5010);
  const timeline = csv([
    {
      kind: "end",
      clock: {
        end: { wallMs: 42, monotonicMs: 43 },
        monotonicElapsedMs: 1800000,
        wallElapsedMs: 1800001,
        wallDriftMs: 1,
      },
    },
  ]);
  assert.match(timeline, /monotonicElapsedMs/);
  assert.match(timeline, /1800000/);
  assert.equal(m.evidenceComplete, false);
});
