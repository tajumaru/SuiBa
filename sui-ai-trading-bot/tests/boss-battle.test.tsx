import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BossBattle, BossBattleCard } from "../apps/dashboard/src/BossBattle.tsx";
import type { BossBattleState } from "../packages/shared/src/boss.ts";
import { partyNames } from "../packages/shared/src/party.ts";

const boss: BossBattleState = {
  startedAt: 1,
  type: "lightning",
  name: "閃光の投げ売り",
  strength: "通常",
  drop: 0.03,
  windowSeconds: 3600,
  high: 100,
  low: 97,
  startingEquity: 100,
  recovery: 0,
  turn: "boss",
  latestEvent: null,
  retreatReason: null,
  outcome: null,
};
const stats = { level: 1, equity: 100, hasPosition: false, unrealized: null };

describe("boss battle sheet participation", () => {
  it("shows only members who acted with their icons and counts", () => {
    const activeBoss = { ...boss, partyActions: { shield: 2, healer: 1, forecast: 0 } };
    const html = renderToStaticMarkup(<BossBattle boss={activeBoss} stats={stats} />);
    expect(html).toContain("参戦");
    expect(html).toContain(partyNames.shield + " ×2");
    expect(html).toContain("party-shield.webp");
    expect(html).toContain(partyNames.healer + " ×1");
    expect(html).toContain("party-healer.webp");
    expect(html).not.toContain(partyNames.forecast);
    expect(html).not.toContain(partyNames.shadow);
    expect(renderToStaticMarkup(<BossBattleCard boss={activeBoss} stats={stats} />))
      .not.toContain("参戦");
  });

  it.each([undefined, {}, { forecast: 0, shield: 0, shadow: 0, healer: 0 }])(
    "hides the strip without any recorded actions (%j)",
    (partyActions) => {
      const html = renderToStaticMarkup(<BossBattle boss={{ ...boss, partyActions }} stats={stats} />);
      expect(html).not.toContain("参戦");
      expect(html).not.toContain("boss-party");
    },
  );
});
