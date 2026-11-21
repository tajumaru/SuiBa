export const partyNames = {
  hero: "主人公",
  shield: "まもりの盾",
  forecast: "さきよみ",
  shadow: "かげの声",
  healer: "ホーリー",
  sage: "けんじゃ",
} as const;

export type PartyMember = keyof typeof partyNames;
export const partyMembers = Object.keys(partyNames) as PartyMember[];

export function partyLevel(member: PartyMember, count: number) {
  if (member === "sage")
    return { count, level: 999, remaining: null, progress: 1 };

  const scale = member === "hero" || member === "shield" ? 1 : 10;
  let level = 1;
  let previous = 0;
  const thresholds = member === "healer" ? [2, 5, 10, 20] : [5 * scale, 15 * scale];
  let next = thresholds[0];
  while (count >= next) {
    level++;
    previous = next;
    next = thresholds[level - 1] ?? next * 2;
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
