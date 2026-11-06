import type { EpisodeSummary } from "../../../packages/shared/src/paper-recovery.ts";
import { APP_BUILD, versionSkew } from "./appVersion.ts";
import type { OperationsSnapshot } from "./operationsTypes.ts";

/**
 * The AI diagnostic export: a self-describing Markdown snapshot
 * of the operations state, built so an AI (or a human) handed
 * this one file can investigate why the bot paused or stopped
 * without any other context. Assembled entirely from the
 * operations snapshot the dashboard already polls — it adds no
 * new endpoint and reads nothing the operator cannot see.
 */

const iso = (ts: number | null | undefined) =>
  ts == null ? "なし" : new Date(ts).toISOString();

export function episodeDurationText(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}分${seconds % 60}秒`;
}

export function episodeSummaryText(e: EpisodeSummary): string {
  const tally = Object.entries(e.tally)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key} ×${count}`)
    .join("、");
  return `期間 ${episodeDurationText(e.durationMs)}・失敗 ${e.failures} 回${tally ? `・内訳： ${tally}` : ""}`;
}

export function buildDiagnosticReport(
  data: OperationsSnapshot,
  now = Date.now(),
): string {
  const s = data.safety;
  const lines: string[] = [
    "# SuiBa 診断レポート（AI調査用）",
    "",
    "これは SuiBa（SUI/USDC の PAPER 売買 Bot）の運用スナップショットです。",
    "目的： Bot が停止・一時停止した原因を、AI がこのファイルだけで切り分けられるようにすること。",
    "読み方：",
    "- status / stopReason が現在の状態。エピソードとは通信障害による一時停止の期間のこと。",
    "- safety.episodeTally は、進行中のエピソードで「何が何回失敗したか」の内訳。",
    "- 直近の記録にある episode は、そのエピソードが閉じた時点の内訳（復帰・完全停止・再起動のいずれか）。",
    "- 時刻は ISO 8601 (UTC)。金額は USDC。",
    "",
    `生成日時： ${iso(now)}`,
    "",
    "## 現在の状態",
    `- status: ${data.status}`,
    `- build: 画面 ${APP_BUILD} / Bot ${data.workerBuild}${versionSkew(APP_BUILD, data.workerBuild) ? "（版がズレています）" : ""}`,
    `- stopReason: ${data.stopReason ?? "なし"}`,
    `- botState: ${s.botState} / connectivity: ${s.connectivity} / resumePending: ${s.resumePending}`,
    `- 稼働： processStartedAt=${iso(data.processStartedAt)} / runningMs=${data.runningMs}`,
    `- 市場： lastMarketAt=${iso(data.lastMarketAt)} / lastQuoteAt=${iso(data.lastQuoteAt)} / lastTradeAt=${iso(data.lastTradeAt)}`,
  ];
  if (s.episodeAt != null) {
    const current: EpisodeSummary = {
      startedAt: s.episodeAt,
      endedAt: now,
      durationMs: Math.max(0, now - s.episodeAt),
      failures: s.failures,
      tally: s.episodeTally,
    };
    lines.push(`- 進行中のエピソード: ${episodeSummaryText(current)}`);
  } else {
    lines.push("- 進行中のエピソード: なし");
  }
  const env = data.environment;
  lines.push(
    "",
    "## 実行環境",
    `- mode: ${env?.mode ?? "不明"} / pair: ${env?.pair ?? "不明"} / 市場プロバイダ: ${env?.provider ?? "不明"}`,
    `- paper-check: ${env == null ? "不明" : !env.paperCheck.enabled ? "無効" : env.paperCheck.armed ? `検証中（期限 ${iso(env.paperCheck.expires)}）` : "有効・未武装"}`,
    `- maintenance: ${env == null ? "不明" : env.maintenance ? "有効（配置ゲートで停止中）" : "なし"}`,
  );
  lines.push(
    `- 最新の API 失敗: ${s.latestApiError ? JSON.stringify(s.latestApiError) : "なし"}`,
    "",
    "## API の状態",
  );
  for (const a of data.apis)
    lines.push(
      `- ${a.api}: circuit=${a.circuit} backoff=${a.backoff} delayed=${a.delayed} requestsPerMinute=${a.requestsPerMinute} lastSuccessAt=${iso(a.lastSuccessAt)}${a.lastFailure ? ` lastFailure=${a.lastFailure.code}@${iso(a.lastFailure.occurredAt)}` : ""}`,
    );
  lines.push("", "## 停止理由の履歴（集計レポートより）");
  for (const r of data.reports) {
    lines.push(`- ${r.hours}時間レポート（${iso(r.from)} 〜 ${iso(r.until)}）: 停止 ${r.stopReasons.length} 件`);
    for (const stop of r.stopReasons)
      lines.push(`  - ${iso(stop.timestamp)}: ${stop.reason}`);
  }
  lines.push(
    "",
    "## 会計チェック",
    `- ledger ok: ${data.accounting.ledger.ok}`,
    `- 最新チェック: ${data.accounting.latest ? JSON.stringify(data.accounting.latest) : "なし"}`,
    "",
    `## 直近の記録（最大50件）`,
  );
  if (data.events.length === 0) lines.push("- 記録なし");
  for (const e of data.events)
    lines.push(
      `- [${iso(e.timestamp)}] ${e.kind} ${e.code}${e.fatal ? " (fatal)" : ""}${e.episode ? ` — episode: ${episodeSummaryText(e.episode)}` : ""}${e.apiFailure ? ` — apiFailure: ${e.apiFailure.api}/${e.apiFailure.code}` : ""}`,
    );
  lines.push(
    "",
    "## 生データ（safety / timing）",
    "```json",
    JSON.stringify({ safety: s, timing: data.timing }, null, 2),
    "```",
    "",
  );
  return lines.join("\n");
}

export function downloadDiagnosticReport(data: OperationsSnapshot): void {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const name = `suiba-diagnostic-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.md`;
  const blob = new Blob([buildDiagnosticReport(data)], {
    type: "text/markdown",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
