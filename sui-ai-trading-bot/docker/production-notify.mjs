// Runner only. GitHub's per-run token never leaves this process or reaches VPS.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const contract = JSON.parse(
  readFileSync(
    new URL("./production-monitor-contract.json", import.meta.url),
    "utf8",
  ),
);
const reasons = new Set([
  ...contract.host_reasons,
  ...contract.monitor_reasons,
]);
export const LABEL = "suiba-production-alert";
export const TITLE = "SuiBa VPS 本番：要確認";
export const MARKER = "<!-- suiba-production-monitor:v1 -->";
const require = (value) => {
  if (!value) throw Error("PRODUCTION_NOTIFICATION_INVALID");
};
const hexId = (value) =>
  typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

export function validateReport(value, now = Date.now() / 1000) {
  require(value && typeof value === "object" && !Array.isArray(value));
  require(
    Object.keys(value).sort().join(",") ===
      "at,prod_state,reasons,run_id,verdict,watchdog_at",
  );
  require(integer(value.at) && value.at <= now + 60);
  require(["ok", "attention", "not_started"].includes(value.verdict));
  require(contract.prod_states.includes(value.prod_state));
  require(
    Array.isArray(value.reasons) &&
      value.reasons.length <= 64 &&
      value.reasons.every((code) => reasons.has(code)),
  );
  require((value.verdict === "attention") === value.reasons.length > 0);
  require(value.run_id === null || hexId(value.run_id));
  require(
    value.watchdog_at === null ||
      (integer(value.watchdog_at) && value.watchdog_at <= value.at + 60),
  );
  if (value.verdict === "not_started")
    require(value.run_id === null && value.prod_state === "not_started");
  if (value.verdict === "ok") {
    require(
      hexId(value.run_id) &&
        ["in_progress", "completed"].includes(value.prod_state),
    );
    require(
      value.watchdog_at === null ||
        (integer(value.watchdog_at) &&
          -60 <= value.at - value.watchdog_at &&
          value.at - value.watchdog_at <= contract.watchdog_max_age),
    );
  }
  return value;
}

export function notificationReport(raw, now = Date.now() / 1000) {
  const fallback = (code) => ({
    at: Math.floor(now),
    verdict: "attention",
    reasons: [code],
    run_id: null,
    prod_state: "unknown",
    watchdog_at: null,
  });
  try {
    require(typeof raw === "string" && raw.length <= 16384);
    const value = validateReport(JSON.parse(raw), now);
    return now - value.at > contract.watchdog_max_age
      ? fallback("CHECK_STALE")
      : value;
  } catch {
    return fallback("CHECK_FAILED");
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
  // No issue or label is created/updated/closed before first production use.
  // An absent run is not proof that a previously failed incident recovered.
  if (report.verdict === "not_started") return { action: "quiet", count: 0 };
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
      : "定期チェックで要注意を検出しました。自動復旧は行っていません。",
    "",
    `- 確認時刻（UTC）: ${new Date(report.at * 1000).toISOString()}`,
    `- 本番状態: \`${report.prod_state}\``,
    `- ラン: \`${report.run_id ?? "unknown"}\``,
    `- watchdog記録（UTC）: ${report.watchdog_at === null ? "未取得" : new Date(report.watchdog_at * 1000).toISOString()}`,
    `- 理由コード: ${report.reasons.map((code) => "\`" + code + "\`").join(", ") || "なし"}`,
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
        description: "SuiBa VPS本番の定期監視通知（自動管理）",
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
      env.PRODUCTION_MONITOR_REPORT ?? "",
      options.now,
    );
    await syncIssues(report, {
      repo: env.GITHUB_REPOSITORY,
      runId: env.GITHUB_RUN_ID,
      token: env.GITHUB_TOKEN,
      ...options,
    });
    return {
      message: "SUIBA_PROD_NOTIFICATION_" + report.verdict.toUpperCase(),
      exitCode: report.verdict === "attention" ? 1 : 0,
    };
  } catch {
    return {
      message: "PRODUCTION_NOTIFICATION_FAILED (details withheld)",
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
