import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { PnlBreakdownLine } from "../apps/dashboard/src/OverviewTab.tsx";

const totals = {
  roundTrips: 3,
  wins: 1,
  realizedPnlUsdc: "-0.2157",
} as Parameters<typeof PnlBreakdownLine>[0]["totals"];

it("renders closed round-trip count, win rate, and average realized P&L", () => {
  expect(
    renderToStaticMarkup(createElement(PnlBreakdownLine, { totals })),
  ).toContain("閉じた往復 3件 ・ 勝率 33% ・ 1回平均 -0.07 USDC");
});

it("hides the breakdown without closed round trips or with stale operations", () => {
  expect(
    renderToStaticMarkup(
      createElement(PnlBreakdownLine, {
        totals: { ...totals!, roundTrips: 0, wins: 0 },
      }),
    ),
  ).toBe("");
  expect(
    renderToStaticMarkup(
      createElement(PnlBreakdownLine, { totals, stale: true }),
    ),
  ).toBe("");
  expect(
    renderToStaticMarkup(createElement(PnlBreakdownLine, { totals: null })),
  ).toBe("");
});
