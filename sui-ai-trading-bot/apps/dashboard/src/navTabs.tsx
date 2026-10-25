import React from "react";

/**
 * Mobile bottom tab bar metadata. On narrow screens (<= 600px) the nav
 * becomes a fixed bottom bar whose buttons pair a line icon with a short
 * label; the desktop nav keeps the formal text label only. The short
 * label is purely visual — every tab button carries the formal name as
 * its aria-label, so assistive technology always hears the full name.
 * Keys are the NAV_TABS values from main.tsx.
 */
export const NAV_SHORT_LABELS: Record<string, string> = {
  Live: "実況",
  Overview: "概要",
  Strategy: "戦略",
  "Trading History": "履歴",
  Settings: "設定",
  運用検証: "検証",
  バックテスト比較: "比較",
};

const ICON_BODY: Record<string, React.ReactNode> = {
  // 実況: speech bubble with two text lines and a tail.
  Live: (
    <>
      <rect x="3" y="4.5" width="18" height="13" rx="3.5" />
      <path d="M8 17.5 7.2 20.8 11.5 17.5" />
      <path d="M7.5 9h9" />
      <path d="M7.5 12.5h6" />
    </>
  ),
  // 概要 (ダッシュボード): four-square grid.
  Overview: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="1.6" />
    </>
  ),
  // 戦略: target (two rings and a filled center dot).
  Strategy: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.6" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  // 履歴 (取引履歴): counterclockwise arrow around clock hands.
  "Trading History": (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6.3L3.5 8" />
      <path d="M3.5 3.5V8H8" />
      <path d="M12 8v4.2l2.6 2" />
    </>
  ),
  // 設定: gear (ring, hub and eight teeth).
  Settings: (
    <>
      <circle cx="12" cy="12" r="6.4" />
      <circle cx="12" cy="12" r="2.3" />
      <path d="M12 2.7v2.9M12 18.4v2.9M2.7 12h2.9M18.4 12h2.9M5.4 5.4l2.1 2.1M16.5 16.5l2.1 2.1M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1" />
    </>
  ),
  // 検証 (運用検証): shield with a check.
  運用検証: (
    <>
      <path d="M12 3l7 2.6V11c0 4.7-2.9 7.9-7 9.4C7.9 18.9 5 15.7 5 11V5.6L12 3Z" />
      <path d="M9.2 11.6l2 2 3.8-4" />
    </>
  ),
  // 比較 (バックテスト比較): two bars of different heights on a baseline.
  バックテスト比較: (
    <>
      <path d="M4 20h16" />
      <rect x="6.6" y="11.5" width="3.8" height="8.5" rx="0.9" />
      <rect x="13.6" y="6.5" width="3.8" height="13.5" rx="0.9" />
    </>
  ),
};

/**
 * Line icon for one nav tab (24x24, stroke follows currentColor).
 * Decorative only: hidden from assistive technology, and hidden by CSS
 * outside the mobile bottom bar. Unknown tabs render nothing.
 */
export function NavTabIcon({ tab }: { tab: string }) {
  const body = ICON_BODY[tab];
  if (body == null) return null;
  return (
    <svg
      className="nav-tab-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {body}
    </svg>
  );
}
