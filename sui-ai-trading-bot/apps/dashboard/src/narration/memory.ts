import type { SituationMemory } from "../../../worker/src/situation-memory.ts";
import type { EntryDraft } from "./state.ts";
import {
  SITUATION_MEMORY_BIAS_PCT,
  SITUATION_MEMORY_MIN_SAMPLES,
} from "../../../worker/src/situation-memory.ts";

export const MEMORY_COOLDOWN_MS = 6 * 3600_000;
export const MEMORY_FRESH_MS = 6 * 60_000;

const labels = {
  up: "上昇局面",
  down: "下降局面",
  range: "横ばい局面",
  unknown: "局面不明",
} as const;

export function memoryNarration(
  statistic: SituationMemory | null | undefined,
  cooldowns: Readonly<Record<string, number>>,
  now: number,
): { draft: EntryDraft; key: string } | null {
  if (!statistic) return null;
  const mean =
    statistic.scene !== "decision"
      ? statistic.mean24hPct
      : statistic.mean4hPct;
  if (
    statistic.n < SITUATION_MEMORY_MIN_SAMPLES ||
    Math.abs(mean) < SITUATION_MEMORY_BIAS_PCT ||
    statistic.evaluatedAt > now ||
    now - statistic.evaluatedAt > MEMORY_FRESH_MS ||
    now - (cooldowns[statistic.key] ?? 0) < MEMORY_COOLDOWN_MS
  )
    return null;
  const sign = mean >= 0 ? "+" : "";
  const base =
    statistic.scene !== "decision"
      ? `${statistic.scene === "liquidation-spike" ? "外部参考のロング清算スパイクを伴う急落後" : "この手の急落後"}、過去 n=${statistic.n} はコスト控除後の +24h 平均 ${sign}${mean.toFixed(2)}%、プラス率 ${statistic.positiveRate.toFixed(0)}%です。`
      : `この手の${labels[statistic.regime]}、過去 n=${statistic.n} はコスト控除後の +4h 平均 ${sign}${mean.toFixed(2)}%、プラス率 ${statistic.positiveRate.toFixed(0)}%です。`;
  return {
    key: statistic.key,
    draft: {
      at: now,
      kind: "memory",
      text:
        statistic.scene === "decision" && statistic.recall
          ? `${base} 記憶には「${statistic.recall}」があります。`
          : base,
    },
  };
}
