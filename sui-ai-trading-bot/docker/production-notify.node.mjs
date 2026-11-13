import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LABEL,
  TITLE,
  MARKER,
  validateReport,
  notificationReport,
  syncIssues,
  executeNotification,
} from "./production-notify.mjs";

const report = (verdict = "attention") => ({
  at: 2000,
  verdict,
  reasons: verdict === "attention" ? ["MARKET_STALE"] : [],
  run_id: "a".repeat(32),
  prod_state: "in_progress",
  watchdog_at: 1999,
});
const issue = (number, extra = {}) => ({
  number,
  title: TITLE,
  body: MARKER + "\nSECRET_FIXTURE_OLD_BODY",
  labels: [{ name: LABEL }],
  ...extra,
});
function fixture(responses) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({
      url,
      method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    assert.equal(options.headers.Authorization, "Bearer fixture-only");
    assert.ok(url.startsWith("https://api.github.com/repos/tajumaru/SuiBa/"));
    assert.ok(responses.length, "unexpected network call");
    const [method, match, status, data] = responses.shift();
    assert.equal(options.method, method);
    assert.ok(url.includes(match), url);
    return new Response(JSON.stringify(data), { status });
  };
  return {
    calls,
    fetch,
    context: {
      repo: "tajumaru/SuiBa",
      runId: "123",
      token: "fixture-only",
      fetch,
      now: 2000,
    },
  };
}

test("attention creates one dedicated label/issue and includes only safe observation fields", async () => {
  const f = fixture([
    ["GET", "/issues?", 200, []],
    ["GET", "/labels/", 404, {}],
    ["POST", "/labels", 201, { name: LABEL }],
    ["POST", "/issues", 201, { number: 5 }],
  ]);
  assert.deepEqual(await syncIssues(report(), f.context), {
    action: "created",
    count: 1,
  });
  const body = f.calls.at(-1).body;
  assert.deepEqual(body.labels, [LABEL]);
  assert.equal(body.title, TITLE);
  assert.ok(body.body.startsWith(MARKER + "\n"));
  assert.ok(body.body.includes("MARKET_STALE"));
  assert.ok(
    body.body.includes("https://github.com/tajumaru/SuiBa/actions/runs/123"),
  );
  assert.ok(!body.body.includes("fixture-only"));
});

test("attention with a failure summary names the stage, code and backup state", async () => {
  const f = fixture([
    ["GET", "/issues?", 200, []],
    ["GET", "/labels/", 404, {}],
    ["POST", "/labels", 201, { name: LABEL }],
    ["POST", "/issues", 201, { number: 5 }],
  ]);
  const value = {
    ...report(),
    reasons: ["REVIEW_REQUIRED", "RUN_FAILED"],
    prod_state: "failed_requires_review",
    failure: {
      status: "failed_requires_review",
      stage: "worker-readiness",
      code: "BACKUP_UNCONFIRMED",
      http_status: 503,
      backup: "unconfirmed",
    },
  };
  assert.deepEqual(validateReport(value, 2000), value);
  assert.deepEqual(await syncIssues(value, f.context), {
    action: "created",
    count: 1,
  });
  const body = f.calls.at(-1).body.body;
  assert.ok(body.includes("- 失敗段階: `worker-readiness`"));
  assert.ok(body.includes("- 失敗コード: `BACKUP_UNCONFIRMED`"));
  assert.ok(body.includes("- HTTP状態: `503`"));
  assert.ok(body.includes("- バックアップ: 未確認"));
  // The failure lines sit with the other diagnosis fields, before
  // the run link.
  assert.ok(body.indexOf("- 理由コード:") < body.indexOf("- 失敗段階:"));
  assert.ok(body.indexOf("- バックアップ:") < body.indexOf("- [チェック実行]"));
});

test("attention with a mid-run failure summary names the monitoring stage and the worker's stop reason", async () => {
  const f = fixture([
    ["GET", "/issues?", 200, []],
    ["GET", "/labels/", 404, {}],
    ["POST", "/labels", 201, { name: LABEL }],
    ["POST", "/issues", 201, { number: 5 }],
  ]);
  const value = {
    ...report(),
    reasons: ["REVIEW_REQUIRED", "RUN_FAILED"],
    prod_state: "failed_requires_review",
    failure: {
      status: "failed_requires_review",
      stage: "monitoring",
      code: "UPSTREAM_HTTP_500",
      http_status: null,
      backup: "unconfirmed",
    },
  };
  assert.deepEqual(validateReport(value, 2000), value);
  assert.deepEqual(await syncIssues(value, f.context), {
    action: "created",
    count: 1,
  });
  const body = f.calls.at(-1).body.body;
  assert.ok(body.includes("- 失敗段階: `monitoring`"));
  assert.ok(body.includes("- 失敗コード: `UPSTREAM_HTTP_500`"));
  assert.ok(!body.includes("HTTP状態"));
  assert.ok(body.includes("- バックアップ: 未確認"));
});

for (const code of [
  "EXTERNAL_STOP",
  "WORKER_OOM",
  "WORKER_EXITED",
  "WORKER_EXITED_CLEAN",
  "UNKNOWN",
]) {
  test(`host stop code ${code} reaches the alert Issue`, async () => {
    const f = fixture([
      ["GET", "/issues?", 200, []],
      ["GET", "/labels/", 404, {}],
      ["POST", "/labels", 201, { name: LABEL }],
      ["POST", "/issues", 201, { number: 5 }],
    ]);
    const value = {
      ...report(),
      reasons: ["REVIEW_REQUIRED", "RUN_FAILED"],
      prod_state: "failed_requires_review",
      failure: {
        status: "failed_requires_review",
        stage: "monitoring",
        code,
        http_status: null,
        backup: "unconfirmed",
      },
    };
    assert.deepEqual(validateReport(value, 2000), value);
    await syncIssues(value, f.context);
    assert.ok(f.calls.at(-1).body.body.includes(`- 失敗コード: \`${code}\``));
  });
}

test("failure summary without an HTTP status omits that line only", async () => {
  const f = fixture([
    ["GET", "/issues?", 200, []],
    ["GET", "/labels/", 404, {}],
    ["POST", "/labels", 201, { name: LABEL }],
    ["POST", "/issues", 201, { number: 5 }],
  ]);
  const value = {
    ...report(),
    failure: {
      status: "failed_requires_review",
      stage: null,
      code: null,
      http_status: null,
      backup: "confirmed",
    },
  };
  await syncIssues(value, f.context);
  const body = f.calls.at(-1).body.body;
  assert.ok(body.includes("- 失敗段階: `unknown`"));
  assert.ok(body.includes("- 失敗コード: `unknown`"));
  assert.ok(!body.includes("HTTP状態"));
  assert.ok(body.includes("- バックアップ: 確認済み"));
});

test("malformed failure summaries cannot be rendered", () => {
  const good = {
    status: "failed_requires_review",
    stage: "backup",
    code: null,
    http_status: null,
    backup: "unknown",
  };
  for (const failure of [
    { ...good, extra: "SECRET_FIXTURE" },
    { ...good, stage: "SECRET_FIXTURE" },
    { ...good, code: "not a code" },
    { ...good, http_status: 99 },
    { ...good, http_status: "503" },
    { ...good, backup: "SECRET_FIXTURE" },
    { ...good, status: "SECRET_FIXTURE" },
    "SECRET_FIXTURE",
  ]) {
    assert.throws(() => validateReport({ ...report(), failure }, 2000));
    assert.deepEqual(
      notificationReport(
        JSON.stringify({ ...report(), failure }),
        2000,
      ).reasons,
      ["CHECK_FAILED"],
    );
  }
});

test("existing managed alerts are updated without new issues or comments", async () => {
  const f = fixture([
    ["GET", "/issues?", 200, [issue(3), issue(4)]],
    ["PATCH", "/issues/3", 200, {}],
    ["PATCH", "/issues/4", 200, {}],
  ]);
  assert.deepEqual(await syncIssues(report(), f.context), {
    action: "updated",
    count: 2,
  });
  assert.ok(f.calls.slice(1).every((call) => !("state" in call.body)));
  assert.ok(
    !JSON.stringify(f.calls.slice(1)).includes("SECRET_FIXTURE_OLD_BODY"),
  );
});

test("healthy observations never create issues or labels", async () => {
  const f = fixture([["GET", "/issues?", 200, []]]);
  assert.deepEqual(await syncIssues(report("ok"), f.context), {
    action: "closed",
    count: 0,
  });
  assert.equal(f.calls.length, 1);
});

test("recovery closes only dedicated, marked, non-PR alerts", async () => {
  const items = [
    issue(1),
    issue(2, { title: "manual issue" }),
    issue(3, { body: "manual body" }),
    issue(4, { pull_request: {} }),
    issue(5, { labels: [] }),
    issue(6),
  ];
  const f = fixture([
    ["GET", "/issues?", 200, items],
    ["PATCH", "/issues/1", 200, {}],
    ["PATCH", "/issues/6", 200, {}],
  ]);
  assert.deepEqual(await syncIssues(report("ok"), f.context), {
    action: "closed",
    count: 2,
  });
  assert.ok(
    f.calls
      .slice(1)
      .every(
        (call) =>
          call.body.state === "closed" &&
          call.body.state_reason === "completed",
      ),
  );
});

test("not started makes no GitHub calls and does not mislabel a prior incident as recovered", async () => {
  const f = fixture([]);
  const value = {
    ...report("not_started"),
    run_id: null,
    prod_state: "not_started",
    watchdog_at: null,
  };
  assert.deepEqual(await syncIssues(value, f.context), {
    action: "quiet",
    count: 0,
  });
  assert.equal(f.calls.length, 0);
});

test("pagination does not create a duplicate alert hidden on the next page", async () => {
  const f = fixture([
    [
      "GET",
      "page=1",
      200,
      Array.from({ length: 100 }, (_, i) => issue(i + 1, { title: "manual" })),
    ],
    ["GET", "page=2", 200, [issue(101)]],
    ["PATCH", "/issues/101", 200, {}],
  ]);
  assert.equal((await syncIssues(report(), f.context)).action, "updated");
});

test("label creation race is verified, not retried as another mutation", async () => {
  const f = fixture([
    ["GET", "/issues?", 200, []],
    ["GET", "/labels/", 404, {}],
    ["POST", "/labels", 422, {}],
    ["GET", "/labels/", 200, { name: LABEL }],
    ["POST", "/issues", 201, { number: 5 }],
  ]);
  await syncIssues(report(), f.context);
  assert.equal(
    f.calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/labels"),
    ).length,
    1,
  );
  assert.equal(
    f.calls.filter(
      (call) => call.method === "POST" && call.url.endsWith("/issues"),
    ).length,
    1,
  );
});

test("bad shapes, unsafe values and unknown reason codes cannot be rendered or close issues", () => {
  for (const extra of [
    { reasons: ["SECRET_FIXTURE"] },
    { run_id: "<script>" },
    { at: NaN },
    { watchdog_at: 1e15 },
    { prod_state: "SECRET_FIXTURE" },
    { extra: "SECRET_FIXTURE" },
  ]) {
    assert.throws(() => validateReport({ ...report(), ...extra }, 2000));
    assert.deepEqual(
      notificationReport(JSON.stringify({ ...report(), ...extra }), 2000)
        .reasons,
      ["CHECK_FAILED"],
    );
  }
  assert.deepEqual(notificationReport("SECRET_FIXTURE", 2000).reasons, [
    "CHECK_FAILED",
  ]);
  assert.deepEqual(
    notificationReport(
      JSON.stringify({ ...report("ok"), at: 1000, watchdog_at: 999 }),
      2000,
    ).reasons,
    ["CHECK_STALE"],
  );
});

test("a stale healthy check becomes attention instead of closing an incident", async () => {
  const f = fixture([
    ["GET", "/issues?", 200, [issue(1)]],
    ["PATCH", "/issues/1", 200, {}],
  ]);
  const env = {
    GITHUB_REPOSITORY: "tajumaru/SuiBa",
    GITHUB_RUN_ID: "123",
    GITHUB_TOKEN: "fixture-only",
    PRODUCTION_MONITOR_REPORT: JSON.stringify({
      ...report("ok"),
      at: 1000,
      watchdog_at: 999,
    }),
  };
  const result = await executeNotification(env, { fetch: f.fetch, now: 2000 });
  assert.equal(result.exitCode, 1);
  assert.ok(f.calls.at(-1).body.body.includes("CHECK_STALE"));
  assert.ok(!("state" in f.calls.at(-1).body));
});

test("network and API failures emit a fixed result without credentials or response text", async () => {
  const env = {
    GITHUB_REPOSITORY: "tajumaru/SuiBa",
    GITHUB_RUN_ID: "123",
    GITHUB_TOKEN: "SECRET_FIXTURE",
    PRODUCTION_MONITOR_REPORT: JSON.stringify(report()),
  };
  for (const fetch of [
    async () => {
      throw Error("SECRET_FIXTURE");
    },
    async () => new Response("SECRET_FIXTURE_RESPONSE", { status: 500 }),
  ]) {
    const result = await executeNotification(env, { fetch, now: 2000 });
    assert.equal(result.exitCode, 1);
    assert.ok(!JSON.stringify(result).includes("SECRET_FIXTURE"));
    assert.equal(
      result.message,
      "PRODUCTION_NOTIFICATION_FAILED (details withheld)",
    );
  }
});

test("live healthy status can close an alert when the optional watchdog record is missing or invalid", async () => {
  const f = fixture([
    ["GET", "/issues?", 200, [issue(6)]],
    ["PATCH", "/issues/6", 200, { number: 6 }],
  ]);
  const value = { ...report("ok"), watchdog_at: null };
  assert.deepEqual(notificationReport(JSON.stringify(value), 2000), value);
  assert.deepEqual(await syncIssues(value, f.context), {
    action: "closed",
    count: 1,
  });
  assert.equal(f.calls[1].body.state, "closed");
});
