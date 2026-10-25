import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { label } from "../apps/dashboard/src/presentation.ts";
import {
  NAV_SHORT_LABELS,
  NavTabIcon,
} from "../apps/dashboard/src/navTabs.tsx";

// The NAV_TABS keys from main.tsx, with the formal Japanese name each
// one shows on desktop (label() falls back to the raw key when it has
// no entry, mirroring the nav rendering in main.tsx).
const TABS: Array<{ tab: string; formal: string; short: string }> = [
  { tab: "Live", formal: "実況", short: "実況" },
  { tab: "Overview", formal: "ダッシュボード", short: "概要" },
  { tab: "Strategy", formal: "戦略", short: "戦略" },
  { tab: "Trading History", formal: "取引履歴", short: "履歴" },
  { tab: "Settings", formal: "設定", short: "設定" },
  { tab: "運用検証", formal: "運用検証", short: "検証" },
  { tab: "バックテスト比較", formal: "バックテスト比較", short: "比較" },
];

const formalOf = (tab: string) => (label(tab) === "未確認" ? tab : label(tab));

describe("mobile bottom tab bar metadata", () => {
  it("covers exactly the seven nav tabs", () => {
    expect(Object.keys(NAV_SHORT_LABELS).sort()).toEqual(
      TABS.map((t) => t.tab).sort(),
    );
  });

  it("maps every tab to its approved short label", () => {
    for (const { tab, formal, short } of TABS) {
      expect(formalOf(tab)).toBe(formal);
      expect(NAV_SHORT_LABELS[tab]).toBe(short);
      // Short labels must fit a seven-item bottom bar.
      expect([...short].length).toBeLessThanOrEqual(2);
    }
    // The four renamed tabs really are shortened; the rest keep
    // their formal name as the short label.
    for (const tab of [
      "Overview",
      "Trading History",
      "運用検証",
      "バックテスト比較",
    ])
      expect(NAV_SHORT_LABELS[tab]).not.toBe(formalOf(tab));
    for (const tab of ["Live", "Strategy", "Settings"])
      expect(NAV_SHORT_LABELS[tab]).toBe(formalOf(tab));
  });

  it("renders one distinct line icon per tab", () => {
    const seen = new Set<string>();
    for (const { tab } of TABS) {
      const html = renderToStaticMarkup(<NavTabIcon tab={tab} />);
      expect(html).toContain("<svg");
      expect(html).toContain('class="nav-tab-icon"');
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-width="1.8"');
      expect(html).toContain('aria-hidden="true"');
      expect(seen.has(html)).toBe(false);
      seen.add(html);
    }
    expect(seen.size).toBe(TABS.length);
  });

  it("renders nothing for an unknown tab", () => {
    expect(renderToStaticMarkup(<NavTabIcon tab="Chart" />)).toBe("");
  });
});
