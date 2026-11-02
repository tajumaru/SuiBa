import fs from "node:fs";
import { parseDeepBook } from "../packages/market-data/src/deepbook.ts";
import {
  reconstructFiveMinutes,
  type EmptyTradeProof,
} from "../packages/market-data/src/reconstruction.ts";
import { classifyChartGap } from "../packages/shared/src/chart-gaps.ts";

// The slices of the captured Indexer evidence file this audit reads.
interface EvidencePipeline {
  pipeline: string;
  is_backfill: boolean;
  indexed_timestamp_ms: number;
}
interface EvidenceGap {
  timestamp: number;
  fetchedAt: number;
  complete: boolean;
  validRange: boolean;
  path: string;
  trades: { timestamp: number }[] | null;
}
const file = process.argv[2] ?? "docs/evidence/chart-gaps-48/responses.json",
  raw = JSON.parse(fs.readFileSync(file, "utf8")),
  original = process.argv[3]
    ? JSON.parse(fs.readFileSync(process.argv[3], "utf8"))
    : { rows: raw.five };
const now = raw.completedAt,
  through =
    raw.status.status === "OK"
      ? (raw.status.pipelines.find(
          (p: EvidencePipeline) => p.pipeline === "order_fill" && !p.is_backfill,
        )?.indexed_timestamp_ms ?? 0)
      : 0;
const five = parseDeepBook(
    { candles: raw.five },
    300,
    now,
  ) as import("../packages/shared/src/index.ts").Candle[],
  minutes = parseDeepBook({ candles: raw.minutes }, 60, now),
  proofs = new Map<number, EmptyTradeProof>();
const records = raw.gaps.map((g: EvidenceGap) => {
  const parts = minutes.filter(
      (m) => m.timestamp >= g.timestamp && m.timestamp < g.timestamp + 300,
    ),
    fivePresent = five.some((c) => c.timestamp === g.timestamp);
  const cause = classifyChartGap({
    ...g,
    indexedThrough: through,
    minuteCount: parts.length,
    fivePresent,
  });
  if (cause === "NO_TRADES_VERIFIED")
    proofs.set(g.timestamp, {
      source: "DeepBook Indexer",
      pair: "SUI_USDC",
      start: g.timestamp,
      end: g.timestamp + 300,
      fetchedAt: g.fetchedAt,
      indexedThrough: through,
      complete: g.complete,
      tradeCount: 0,
      path: g.path,
    });
  const previous = five.filter((c) => c.timestamp < g.timestamp).at(-1),
    next = five.find((c) => c.timestamp > g.timestamp);
  return {
    timestamp: g.timestamp,
    utc: new Date(g.timestamp * 1000).toISOString(),
    jst: new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      dateStyle: "short",
      timeStyle: "long",
    }).format(g.timestamp * 1000),
    cause,
    observedAt: g.fetchedAt,
    tradePath: g.path,
    tradeResponse: g.trades,
    complete: g.complete,
    validRange: g.validRange,
    indexedThrough: through,
    minuteCount: parts.length,
    fivePresent,
    previous,
    next,
  };
});
const rebuilt = reconstructFiveMinutes(five, minutes, proofs, now),
  repairs = rebuilt.candles.filter((c) => c.provenance?.origin !== "ORIGINAL");
const groups: number[][] = [];
for (const r of records) {
  const last = groups.at(-1);
  if (last && r.timestamp === last.at(-1)! + 300) last.push(r.timestamp);
  else groups.push([r.timestamp]);
}
const report = {
  from: raw.from,
  to: raw.to,
  observedAt: now,
  expected: 2016,
  originalCount: 1968,
  originalDuplicates:
    original.rows.length - new Set(original.rows.map((r: number[]) => r[0])).size,
  invalidOriginal: original.rows.filter(
    (r: number[]) =>
      r[0] % 300000 || r.slice(1).some((v: number) => !Number.isFinite(v)),
  ).length,
  groups,
  causeCounts: records.reduce(
    (a: Record<string, number>, r: (typeof records)[number]) => ((a[r.cause] = (a[r.cause] ?? 0) + 1), a),
    {},
  ),
  reconstructed: repairs.length,
  unresolved: rebuilt.quality.unresolved,
  records,
  repairs,
};
fs.mkdirSync("docs/evidence/chart-gaps-48", { recursive: true });
if (file !== "docs/evidence/chart-gaps-48/responses.json")
  fs.copyFileSync(file, "docs/evidence/chart-gaps-48/responses.json");
fs.writeFileSync(
  "docs/evidence/chart-gaps-48/report.json",
  JSON.stringify(report, null, 2),
);
fs.writeFileSync(
  "packages/shared/src/chart-gap-audit.ts",
  `// Captured, public Indexer evidence. DISPLAY ONLY; never imported by trading providers.\nimport type {Candle} from './index.ts';\nimport type {GapCause} from './chart-gaps.ts';\nexport const auditedChartGaps:${"{timestamp:number;cause:GapCause;observedAt:number;tradePath:string;indexedThrough:number}[]"}=${JSON.stringify(records.map(({ timestamp, cause, observedAt, tradePath, indexedThrough }: (typeof records)[number]) => ({ timestamp, cause, observedAt, tradePath, indexedThrough })))};\nexport const verifiedDisplayRepairs:Candle[]=${JSON.stringify(repairs)};\n`,
);
const lines = [
  "# DeepBook欠損48本の調査",
  "",
  "公式IndexerでNO_TRADES_VERIFIED 48本。独立オンチェーン照合は未実施。生レスポンス・前後OHLCV・ページURLはevidence/chart-gaps-48/に保存。",
  "",
  `無効データ${report.invalidOriginal}本、重複${report.originalDuplicates}本。連続欠損は${groups.length}区間、最大${Math.max(...groups.map((g) => g.length))}本。`,
  "",
  "| UTC（足の開始） | 日本時間 | 分類 |",
  "|---|---|---|",
  ...records.map((r: (typeof records)[number]) => `|${r.utc}|${r.jst}|${r.cause}|`),
  "",
  `既存reconstructFiveMinutesを変更せず適用。表示専用再構築${repairs.length}本、未解決${rebuilt.quality.unresolved}本。Bot側には返さない。`,
];
fs.writeFileSync("docs/archive/DEEPBOOK_GAPS_48_P1.md", lines.join("\n") + "\n");
console.log(
  JSON.stringify({
    causes: report.causeCounts,
    groups: groups.length,
    maxRun: Math.max(...groups.map((g) => g.length)),
    repairs: repairs.length,
    unresolved: report.unresolved,
  }),
);
