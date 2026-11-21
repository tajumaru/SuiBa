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
} as Parameters<typeof Party>[0]["party"];

it("shows an icon for every party member", () => {
  const html = renderToStaticMarkup(createElement(Party, { party }));
  expect(html.match(/overview-party-icon/g)).toHaveLength(4);
  expect(html).toContain("主人公");
  expect(html).toContain("さきよみ");
  expect(html).toContain("まもりの盾");
  expect(html).toContain("かげの声");
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
  expect(wired).toContain('aria-pressed="true"');
  expect(wired).toContain('aria-pressed="false"');
  expect(wired).toContain("data-off");
  expect(wired).toContain("OFF（タップでON）");
  // Without the toggles prop the panel stays a plain readout.
  const plain = renderToStaticMarkup(createElement(Party, { party }));
  expect(plain).not.toContain("overview-party-toggle");
});
