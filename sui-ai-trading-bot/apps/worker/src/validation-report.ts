import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ValidationReport } from "./validation.ts";
const rate = (n: number | null | undefined) =>
  n == null ? "未計測" : `${(n * 100).toFixed(2)}%`;
export function validationMarkdown(r: ValidationReport): string {
  const lines = [
    "# DeepBook 24時間PAPER検証",
    `状態: **${r.status}**`,
    `集計時刻: ${new Date(r.generatedAt).toISOString()}`,
  ];
  if (!r.session) return lines.join("\n\n") + "\n";
  lines.push(
    `計測ID: ${r.session.id}`,
    `開始: ${new Date(r.session.startedAt).toISOString()} / 目標: ${new Date(r.session.targetAt).toISOString()}`,
    `計測時間: ${((r.elapsedMs ?? 0) / 3600000).toFixed(3)}時間 / PAPER実稼働: ${((r.runningMs ?? 0) / 3600000).toFixed(3)}時間`,
    `記録: ${r.sampleCount}件 / 最大空白: ${r.maxGapMs}ms / 市場取得正常率: ${rate(r.cycleSuccessRate)}`,
    "## 運用基準",
    `Workerは処理完了後 ${r.session.intervalMs}ms 待機します。APIのP95目標はこの待機周期未満、実試行成功率99%以上。既存のDeepBookタイムアウト8秒・最大2回再試行を維持します。`,
    "計測は15秒間隔、45秒超の記録空白は不合格。PAPER実稼働は24時間から45秒までの許容差。市場取得は待機周期+再構築予算45秒に対する周期数と正常率99%以上を要求します。",
    "既存の安全条件: 板10秒以内、Indexer遅延60秒以内、確定5分足360秒以内、設定スプレッド・流動性制限、見積もり期限内。未解決欠損ゼロ、再構築45秒以内。これらの条件は緩和しません。",
    "## API（キャッシュ・同時要求の集約を除く実試行）",
    "| API | 件数 | 正常率 | 平均ms | P95ms | 再試行 | 障害内訳 |",
    "|---|---:|---:|---:|---:|---:|---|",
  );
  for (const a of r.apis ?? [])
    lines.push(
      `| ${a.api} | ${a.requests} | ${rate(a.successRate)} | ${a.latency.averageMs?.toFixed(1) ?? "未計測"} | ${a.latency.p95Ms ?? "未計測"} | ${a.retries} | ${JSON.stringify(a.codes)} |`,
    );
  const q = r.candles!,
    p = r.paper!;
  lines.push(
    "## ローソク足品質",
    `取得5分足（UTC時刻の重複除外）: ${q.uniqueFiveMinuteBars} / 元欠損: ${q.originalMissing} / 欠損率: ${rate(q.missingRate)} / 再構築: ${q.reconstructed} / 成功率: ${rate(q.reconstructionSuccessRate)} / 未解決: ${q.unresolved} / 未解決を観測した取得周期: ${q.reconstructionFailures}`,
    `再構築時間: ${JSON.stringify(q.reconstructionTime)} / 最新品質: ${JSON.stringify(q.latestQuality)}`,
    "再構築の理由・取得元・取得時刻・証拠:",
    "```json",
    JSON.stringify(q.evidence, null, 2),
    "```",
    "## 注文板",
    "```json",
    JSON.stringify(r.book, null, 2),
    "```",
    "## AI・PAPER",
    `分析 ${p.analyses} / BUY ${p.actions.BUY} / SELL ${p.actions.SELL} / WAIT ${p.actions.WAIT} / 約定 ${p.orders} / 損益 ${p.pnlUsdc ?? "未評価"} USDC`,
    `安全停止 ${p.safetyStops.length} / 手動開始 ${p.manualStarts} / 手動再開 ${p.manualResumes} / 再起動 ${p.restarts}`,
    `不正約定証拠 ${p.unsafeFills} / 証拠不足 ${p.missingFillEvidence} / 自動再開違反 ${p.unauthorizedRuns}`,
    `約定時安全経路の実行: ${p.fillChecksExercised ? "あり" : "未行使"} / API異常時停止経路の実行: ${p.errorStopChecksExercised ? "あり" : "未行使"}`,
    "安全停止履歴:",
    ...p.safetyStops.map(
      (s) => `- ${new Date(s.timestamp).toISOString()} ${s.code}`,
    ),
    "## 判定",
    ...(r.criteria ?? []).map((c) => `- [${c.ok ? "x" : " "}] ${c.name}`),
    "## 評価範囲・制約",
    ...(r.limitations ?? []).map((x) => `- ${x}`),
  );
  return lines.join("\n\n") + "\n";
}
export function exportValidationReport(dir: string, r: ValidationReport) {
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of [
    ["latest.json", JSON.stringify(r, null, 2) + "\n"],
    ["latest.md", validationMarkdown(r)],
  ]) {
    const file = join(dir, name);
    writeFileSync(file + ".tmp", text, { encoding: "utf8", mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
}
