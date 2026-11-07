// Runner only. GitHub's per-run token never leaves this process or reaches VPS.
import { pathToFileURL } from "node:url";

const REASONS = new Set([
  "PAPER_STATUS_UNAVAILABLE",
  "PAPER_STATUS_INVALID",
  "RUN_FAILED_REQUIRES_REVIEW",
  "CONTROLLER_NOT_RUNNING",
  "PAPER_CHECK_FAILED",
  "PAPER_CHECK_STALE",
]);
const RUN_STATES = new Set([
  "in_progress",
  "finishing",
  "completed",
  "failed_requires_review",
]);
const DURATIONS = new Set(["30m", "6h", "24h"]);
const MAX_REPORT_AGE = 900;
export const LABEL = "suiba-paper-alert";
export const TITLE = "SuiBa VPS 検証：要確認";
export const MARKER = "<!-- suiba-paper-monitor:v1 -->";
const require = (value) => {
  if (!value) throw Error("PAPER_NOTIFICATION_INVALID");
};
const hexId = (value) =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateReport(value, now = Date.now() / 1000) {
  require(value && typeof value === "object" && !Array.isArray(value));
  require(
    Object.keys(value).sort().join(",") ===
      "at,duration,reasons,run_id,run_status,verdict",
  );
  require(integer(value.at) && value.at <= now + 60);
  require(["ok", "attention", "no_run"].includes(value.verdict));
  require(
    Array.isArray(value.reasons) &&
      value.reasons.length <= 8 &&
      value.reasons.every((code) => REASONS.has(code)),
  );
  require((value.verdict === "attention") === value.reasons.length > 0);
  require(value.run_id === null || hexId(value.run_id));
  require(value.run_status === null || RUN_STATES.has(value.run_status));
  require(value.duration === null || DURATIONS.has(value.duration));
  if (value.verdict === "no_run")
    require(value.run_id === null && value.run_status === null);
  if (value.verdict === "ok")
    require(hexId(value.run_id) && RUN_STATES.has(value.run_status));
  if (value.run_status === "failed_requires_review")
    require(
      value.verdict === "attention" &&
        value.reasons.includes("RUN_FAILED_REQUIRES_REVIEW"),
    );
  return value;
}

export function notificationReport(raw, now = Date.now() / 1000) {
  const fallback = (code) => ({
    at: Math.floor(now),
    verdict: "attention",
    reasons: [code],
    run_id: null,
    run_status: null,
    duration: null,
  });
  try {
    require(typeof raw === "string" && raw.length <= 16384);
    const value = validateReport(JSON.parse(raw), now);
    return now - value.at > MAX_REPORT_AGE
      ? fallback("PAPER_CHECK_STALE")
      : value;
  } catch {
    return fallback("PAPER_CHECK_FAILED");
  }
}

export async function syncIssues(
  report,
  { repo, runId, token, fetch = globalThis.fetch, now = Date.now() / 1000 },
) {
  validateReport(report, now);
  require(
    typeof repo === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(
        repo,
      ),
  );
  require(typeof runId === "string" && /^[1-9][0-9]{0,19}$/.test(runId));
  require(typeof token === "string" && token.length > 0);
  // No run record is not proof that a previously failed run recovered.
  if (report.verdict === "no_run") return { action: "quiet", count: 0 };
  const base = `https://api.github.com/repos/${repo}`;
  const api = async (method, path, body, allowed = []) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if (allowed.includes(response.status)) return response.status;
      throw Error("GITHUB_NOTIFICATION_REQUEST_FAILED");
    }
    return response.status === 204 ? null : response.json();
  };
  const managed = [];
  for (let page = 1; ; page++) {
    require(page <= 20);
    const items = await api(
      "GET",
      `/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100&page=${page}`,
    );
    require(Array.isArray(items) && items.length <= 100);
    for (const item of items) {
      if (
        item &&
        !item.pull_request &&
        item.title === TITLE &&
        typeof item.body === "string" &&
        item.body.startsWith(MARKER + "\n") &&
        Array.isArray(item.labels) &&
        item.labels.some((label) => label.name === LABEL)
      ) {
        require(Number.isSafeInteger(item.number) && item.number > 0);
        managed.push(item.number);
      }
    }
    if (items.length < 100) break;
  }
  const body = [
    MARKER,
    "",
    report.verdict === "ok"
      ? "正常な観測を確認したため、この通知を閉じます。"
      : "定期チェックで検証ランの要確認を検出しました。自動復旧は行っていません。",
    "",
    `- 確認時刻（UTC）: ${new Date(report.at * 1000).toISOString()}`,
    `- 検証状態: \`${report.run_status ?? "unknown"}\``,
    `- ラン: \`${report.run_id ?? "unknown"}\``,
    `- 時間枠: \`${report.duration ?? "unknown"}\``,
    `- 理由コード: ${report.reasons.map((code) => "`" + code + "`").join(", ") || "なし"}`,
    `- [チェック実行](https://github.com/${repo}/actions/runs/${runId})`,
  ].join("\n");
  if (report.verdict === "ok") {
    for (const number of managed)
      await api("PATCH", `/issues/${number}`, {
        body,
        state: "closed",
        state_reason: "completed",
      });
    return { action: "closed", count: managed.length };
  }
  if (managed.length) {
    for (const number of managed)
      await api("PATCH", `/issues/${number}`, { body });
    return { action: "updated", count: managed.length };
  }
  let label = await api("GET", `/labels/${LABEL}`, undefined, [404]);
  if (label === 404) {
    label = await api(
      "POST",
      "/labels",
      {
        name: LABEL,
        color: "D93F0B",
        description: "SuiBa VPS検証の定期監視通知（自動管理）",
      },
      [422],
    );
    if (label === 422) label = await api("GET", `/labels/${LABEL}`);
  }
  require(label?.name === LABEL);
  const issue = await api("POST", "/issues", {
    title: TITLE,
    body,
    labels: [LABEL],
  });
  require(Number.isSafeInteger(issue?.number) && issue.number > 0);
  return { action: "created", count: 1 };
}

export async function executeNotification(env, options = {}) {
  try {
    const report = notificationReport(
      env.PAPER_MONITOR_REPORT ?? "",
      options.now,
    );
    await syncIssues(report, {
      repo: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID,
      token: env.GITHUB_TOKEN,
      ...options,
    });
    return {
      message: "SUIBA_PAPER_NOTIFICATION_" + report.verdict.toUpperCase(),
      exitCode: report.verdict === "attention" ? 1 : 0,
    };
  } catch {
    return {
      message: "PAPER_NOTIFICATION_FAILED (details withheld)",
      exitCode: 1,
    };
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await executeNotification(process.env);
  console.log(result.message);
  process.exitCode = result.exitCode;
}
