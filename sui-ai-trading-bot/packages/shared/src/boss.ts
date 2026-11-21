export interface BossBattleState {
  startedAt: number;
  type: "lightning" | "swamp";
  name: string;
  strength: "通常" | "大" | "真";
  drop: number;
  windowSeconds: number;
  high: number;
  low: number;
  startingEquity: number;
  recovery: number;
  turn: "boss" | "hero" | null;
  latestEvent: string | null;
  retreatReason: "loss" | "safety" | "emergency" | null;
  outcome: { at: number; result: "endured" | "retreated" } | null;
}

export function bossAppearance(boss: BossBattleState) {
  return `${boss.name} が あらわれた！`;
}

export function bossDropText(boss: BossBattleState) {
  const hours = boss.windowSeconds / 3600;
  const window =
    boss.windowSeconds % 3600 === 0
      ? `${hours}時間`
      : `${Math.floor(boss.windowSeconds / 60)}分`;
  return `${window}で価格が ${(boss.drop * 100).toFixed(1)}% 下落。`;
}
