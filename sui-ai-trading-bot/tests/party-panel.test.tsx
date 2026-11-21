import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Party } from "../apps/dashboard/src/OverviewTab.tsx";

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
});
