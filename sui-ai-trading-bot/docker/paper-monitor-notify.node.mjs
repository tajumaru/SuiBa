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
} from "./paper-monitor-notify.mjs";

const report = (verdict = "attention") => ({
  at: 2000,
  verdict,
  reasons: verdict === "attention" ? ["RUN_FAILED_REQUIRES_REVIEW"] : [],
  run_id: "a".repeat(32),
  run_status: verdict === "attention" ? "failed_requires_review" : "in_progress",
  duration: "6h",
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
    assert.equal(options.headers.Authorization, "Bearer TEST_TOKEN");
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
      token: "TEST_TOKEN",
      now: 2000,
    },
  };
}

test("validateReport accepts the three verdicts and rejects drift", () => {
  validateReport(report("attention"), 2000);
  validateReport(report("ok"), 2000);
  validateReport(
    { at: 2000, verdict: "no_run", reasons: [], run_id: null, run_status: null, duration: null },
    2000,
  );
  assert.throws(() => validateReport({ ...report("ok"), reasons: ["RUN_FAILED_REQUIRES_REVIEW"] }, 2000));
  assert.throws(() => validateReport({ ...report("attention"), reasons: ["BOGUS"] }, 2000));
  assert.throws(() => validateReport({ ...report("ok"), run_status: "failed_requires_review" }, 2000));
  assert.throws(() => validateReport({ ...report("ok"), extra: 1 }, 2000));
});

test("notificationReport falls back on garbage and on stale reports", () => {
  assert.equal(notificationReport("not json", 2000).reasons[0], "PAPER_CHECK_FAILED");
  assert.equal(
    notificationReport(JSON.stringify(report("ok")), 2000 + 901).reasons[0],
    "PAPER_CHECK_STALE",
  );
  assert.equal(notificationReport(JSON.stringify(report("ok")), 2000).verdict, "ok");
});

test("attention with no managed issue creates the label and the issue", async () => {
  const { calls, fetch, context } = fixture([
    ["GET", "/issues?", 200, []],
    ["GET", "/labels/", 404, { message: "Not Found" }],
    ["POST", "/labels", 201, { name: LABEL }],
    ["POST", "/issues", 201, { number: 7 }],
  ]);
  const result = await syncIssues(report(), { ...context, fetch });
  assert.deepEqual(result, { action: "created", count: 1 });
  const created = calls.at(-1).body;
  assert.equal(created.title, TITLE);
  assert.ok(created.body.startsWith(MARKER + "\n"));
  assert.ok(created.body.includes("RUN_FAILED_REQUIRES_REVIEW"));
  assert.ok(created.body.includes("@tajumaru"));
  assert.ok(!created.body.includes("SECRET"));
});

test("attention updates an existing managed issue instead of duplicating", async () => {
  const { calls, fetch, context } = fixture([
    ["GET", "/issues?", 200, [issue(3), issue(4, { title: "other" }), issue(5, { pull_request: {} })]],
    ["PATCH", "/issues/3", 200, {}],
    ["POST", "/issues/3/comments", 201, {}],
  ]);
  const result = await syncIssues(report(), { ...context, fetch });
  assert.deepEqual(result, { action: "updated", count: 1 });
  assert.equal(calls.length, 3);
  assert.ok(calls.at(-1).body.body.includes("@tajumaru"));
  assert.ok(calls.at(-1).body.body.includes("RUN_FAILED_REQUIRES_REVIEW"));
});

test("the same ongoing failure updates silently, without a new comment", async () => {
  const sameBody =
    MARKER +
    "\n\n- ラン: `" +
    "a".repeat(32) +
    "`\n- 理由コード: `RUN_FAILED_REQUIRES_REVIEW`";
  const { calls, fetch, context } = fixture([
    ["GET", "/issues?", 200, [issue(3, { body: sameBody })]],
    ["PATCH", "/issues/3", 200, {}],
  ]);
  const result = await syncIssues(report(), { ...context, fetch });
  assert.deepEqual(result, { action: "updated", count: 1 });
  assert.equal(calls.length, 2);
});

test("ok closes managed issues; no_run stays quiet", async () => {
  const closing = fixture([
    ["GET", "/issues?", 200, [issue(3)]],
    ["PATCH", "/issues/3", 200, {}],
  ]);
  assert.deepEqual(await syncIssues(report("ok"), { ...closing.context, fetch: closing.fetch }), {
    action: "closed",
    count: 1,
  });
  assert.equal(closing.calls[1].body.state, "closed");
  const quiet = fixture([]);
  assert.deepEqual(
    await syncIssues(
      { at: 2000, verdict: "no_run", reasons: [], run_id: null, run_status: null, duration: null },
      { ...quiet.context, fetch: quiet.fetch },
    ),
    { action: "quiet", count: 0 },
  );
  assert.equal(quiet.calls.length, 0);
});

test("executeNotification reports attention with exit code 1", async () => {
  const { fetch } = fixture([
    ["GET", "/issues?", 200, []],
    ["GET", "/labels/", 200, { name: LABEL }],
    ["POST", "/issues", 201, { number: 9 }],
  ]);
  const result = await executeNotification(
    {
      PAPER_MONITOR_REPORT: JSON.stringify(report()),
      GITHUB_REPOSITORY: "tajumaru/SuiBa",
      GITHUB_RUN_ID: "123",
      GITHUB_TOKEN: "TEST_TOKEN",
    },
    { fetch, now: 2000 },
  );
  assert.equal(result.message, "SUIBA_PAPER_NOTIFICATION_ATTENTION");
  assert.equal(result.exitCode, 1);
});
