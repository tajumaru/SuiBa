import { describe, expect, it } from "vitest";
import { partyLevel, type PartyMember } from "../packages/shared/src/party.ts";

describe("party levels", () => {
  it.each<[PartyMember, number]>([
    ["hero", 1],
    ["shield", 1],
    ["forecast", 10],
    ["shadow", 10],
  ])("uses the agreed boundaries for %s", (member, scale) => {
    expect(partyLevel(member, 0)).toEqual({
      count: 0,
      level: 1,
      remaining: 5 * scale,
      progress: 0,
    });
    const thresholds = [5, 15, 30, 60, 120, 240].map((n) => n * scale);
    thresholds.forEach((count, i) => {
      expect(partyLevel(member, count - 1)).toMatchObject({
        level: i + 1,
        remaining: 1,
      });
      expect(partyLevel(member, count)).toMatchObject({
        level: i + 2,
        progress: 0,
      });
    });
  });

  it("measures progress within the current level and handles the numeric limit", () => {
    expect(partyLevel("forecast", 287)).toEqual({
      count: 287,
      level: 3,
      remaining: 13,
      progress: 137 / 150,
    });
    expect(partyLevel("hero", Number.MAX_SAFE_INTEGER)).toMatchObject({
      remaining: null,
      progress: 1,
    });
  });
});
