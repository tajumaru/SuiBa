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
