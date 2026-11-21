import {
  bossAppearance,
  bossDropText,
  type BossBattleState,
} from "../../../../packages/shared/src/boss.ts";
import {
  trimNarrationEntries,
  type NarrationEntry,
  type NarrationState,
} from "./state.ts";

export function narrateBoss(
  state: NarrationState,
  boss: BossBattleState | null | undefined,
) {
  if (!boss) return state;
  const entries: NarrationEntry[] = [];
  if (boss.startedAt > (state.lastBossStartAt ?? -1)) {
    entries.push({
      id: `bossStart:${boss.startedAt}`,
      at: boss.startedAt,
      kind: "bossStart",
      text: `${bossAppearance(boss)}\n${bossDropText(boss)}`,
    });
  }
  if (boss.outcome && boss.outcome.at > (state.lastBossEndAt ?? -1)) {
    const reason =
      boss.retreatReason === "loss"
        ? "損失で手放したため"
        : boss.retreatReason === "emergency"
          ? "緊急停止が発生したため"
          : "安全停止が発生したため";
    const result =
      boss.outcome.result === "retreated"
        ? `から撤退した（${reason}）。`
        : "の下げを耐え切った。";
    entries.push({
      id: `bossEnd:${boss.outcome.at}`,
      at: boss.outcome.at,
      kind: "bossEnd",
      text: `${boss.name}${result} 価格の下落は出現条件を外れた。`,
    });
  }
  if (!entries.length) return state;
  return {
    ...state,
    lastBossStartAt: boss.startedAt,
    lastBossEndAt: boss.outcome?.at ?? state.lastBossEndAt,
    entries: trimNarrationEntries(
      [...state.entries, ...entries].sort((a, b) => a.at - b.at),
    ),
  };
}
