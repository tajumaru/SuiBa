export const partyNames = {
  hero: "主人公",
  shield: "まもりの盾",
  forecast: "さきよみ",
  shadow: "かげの声",
} as const;

export type PartyMember = keyof typeof partyNames;
export const partyMembers = Object.keys(partyNames) as PartyMember[];

export function partyLevel(member: PartyMember, count: number) {
  const scale = member === "hero" || member === "shield" ? 1 : 10;
  let level = 1;
  let previous = 0;
  let next = 5 * scale;
  while (count >= next) {
    level++;
    previous = next;
    next = level === 2 ? 15 * scale : next * 2;
    if (!Number.isSafeInteger(next))
      return { count, level, remaining: null, progress: 1 };
  }
  return {
    count,
    level,
    remaining: next - count,
    progress: (count - previous) / (next - previous),
  };
}
