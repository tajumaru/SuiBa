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
  if (
    !statistic ||
    statistic.n < SITUATION_MEMORY_MIN_SAMPLES ||
    Math.abs(statistic.mean4hPct) < SITUATION_MEMORY_BIAS_PCT ||
    statistic.evaluatedAt > now ||
    now - statistic.evaluatedAt > MEMORY_FRESH_MS ||
    now - (cooldowns[statistic.key] ?? 0) < MEMORY_COOLDOWN_MS
  )
    return null;
  const sign = statistic.mean4hPct >= 0 ? "+" : "";
  const base = `この手の${labels[statistic.regime]}、過去 n=${statistic.n} はコスト控除後の +4h 平均 ${sign}${statistic.mean4hPct.toFixed(2)}%、プラス率 ${statistic.positiveRate.toFixed(0)}%です。`;
  return {
    key: statistic.key,
    draft: {
      at: now,
      kind: "memory",
      text: statistic.recall
        ? `${base} 記憶には「${statistic.recall}」があります。`
        : base,
    },
  };
}
