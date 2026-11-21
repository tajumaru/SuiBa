import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Party } from "../apps/dashboard/src/PartyPanel.tsx";

const entry = { level: 1, progress: 0, remaining: 5 };
const party = {
  hero: entry,
  forecast: { level: 5, progress: 0.4, remaining: 372 },
  shield: { level: 1, progress: 0.8, remaining: 1 },
  shadow: { level: 1, progress: 0, remaining: 50 },
  healer: { level: 5, progress: 0.05, remaining: 19 },
  sage: { level: 999, progress: 1, remaining: null },
} as Parameters<typeof Party>[0]["party"];

it("shows an icon for every party member", () => {
  const html = renderToStaticMarkup(createElement(Party, { party }));
  expect(html.match(/overview-party-icon/g)).toHaveLength(6);
  expect(html).toContain("主人公");
  expect(html).toContain("さきよみ");
  expect(html).toContain("まもりの盾");
  expect(html).toContain("かげの声");
  expect(html).toContain("ホーリー");
  expect(html).toMatch(/けんじゃ<\/span><strong>Lv\.999<\/strong><progress max="1" value="1" aria-label="けんじゃの経験値"><\/progress><small>毎朝の振り返り担当<\/small>/);
  expect(html).toContain("Lv.5");
});

it("renders nothing without party data", () => {
  expect(renderToStaticMarkup(createElement(Party, { party: undefined }))).toBe("");

  const toggles = {
    profitGuardEnabled: true,
    shadowEnabled: false,
    onToggle: async () => {},
  };
  const wired = renderToStaticMarkup(createElement(Party, { party, toggles }));
  // Shield and shadow rows become toggle buttons; the OFF member
  // (shadow here) greys out and says OFF instead of a level.
  expect(wired.match(/overview-party-toggle/g)).toHaveLength(2);
  expect(wired.match(/<button[^>]*aria-label="[^"]+"/g)).toEqual([
    expect.stringContaining('aria-label="まもりの盾をOFFにする"'),
    expect.stringContaining('aria-label="かげの声をONにする"'),
  ]);
  expect(wired).toContain('aria-pressed="true"');
  expect(wired).toContain('aria-pressed="false"');
  expect(wired).toContain("data-off");
  expect(wired).toContain("OFF（タップでON）");
  // Without the toggles prop the panel stays a plain readout.
  const plain = renderToStaticMarkup(createElement(Party, { party }));
  expect(plain).not.toContain("overview-party-toggle");
});

const bossHistory: NonNullable<Parameters<typeof Party>[0]["bossHistory"]> =
  Array.from({ length: 7 }, (_, index) => ({
    startedAt: Date.UTC(2026, 0, 6 - index, 22),
    endedAt: Date.UTC(2026, 0, 6 - index, 23),
    type: "lightning",
    name: `閃光の投げ売り・${7 - index}`,
    strength: "通常",
    result: index === 0 ? "endured" : "retreated",
    drop: 0.032,
    recovery: 0.9,
  }));

it("shows completed battles below the party members", () => {
  const html = renderToStaticMarkup(createElement(Party, { party, bossHistory: bossHistory.slice(0, 2) }));
  expect(html.indexOf("ボス戦の戦績")).toBeGreaterThan(html.indexOf("けんじゃ"));
  expect(html).toMatch(/01\/07<\/time>.*閃光の投げ売り・7<\/span><span>耐え切った<\/span><span>−3\.2%/);
  expect(html).toMatch(/01\/06<\/time>.*閃光の投げ売り・6<\/span><span>撤退<\/span>/);
  expect(html).not.toContain("ほか");
});

it("shows the newest five battles and the remaining count", () => {
  const html = renderToStaticMarkup(createElement(Party, { party, bossHistory }));
  expect([...html.matchAll(/<time [^>]+>(.*?)<\/time>/g)].map((match) => match[1]))
    .toEqual(["01/07", "01/06", "01/05", "01/04", "01/03"]);
  expect(html).toContain("ほか2件");
});

it("omits the history block with no completed battles", () => {
  const html = renderToStaticMarkup(createElement(Party, { party, bossHistory: [] }));
  expect(html).not.toContain("ボス戦の戦績");
});
