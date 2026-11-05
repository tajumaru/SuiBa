import { readFileSync } from "node:fs";

// Wiring tests assert on surfaces ("the app shell renders X"),
// not on which file of the surface happens to hold the markup.
// Reading one file per assertion made every component split
// (PriceChart, then main.tsx) break a handful of tests whose
// intent had not changed — the markup had only moved to a
// sibling file. These groups are the surfaces: when a surface
// splits again, add the new file to its group here, in one
// line, instead of retargeting every test.
//
// Group order matters for the ordering assertions (indexOf
// relations): the composition root comes first and each file's
// own text stays contiguous, so relations that held inside one
// file keep holding, and cross-file relations follow the
// render order the root composes.

export function readDashboardFile(name: string): string {
  return readFileSync(
    new URL(`../../apps/dashboard/src/${name}`, import.meta.url),
    "utf8",
  );
}

export function readDashboardFiles(names: readonly string[]): string {
  return names.map((name) => readDashboardFile(name)).join("\n");
}

// The app shell: the composition root plus the pieces it was
// split into (header/avatar, overview tab, forecast hook).
export const APP_SHELL_FILES = [
  "main.tsx",
  "AppHeader.tsx",
  "OverviewTab.tsx",
  "useForecastSuite.ts",
] as const;

export function readAppShell(): string {
  return readDashboardFiles(APP_SHELL_FILES);
}

// The overview tab surface (a single component today; the
// group is the seam if it splits like the shell did).
export const OVERVIEW_FILES = ["OverviewTab.tsx"] as const;

export function readOverview(): string {
  return readDashboardFiles(OVERVIEW_FILES);
}

// The narration feed surface: the feed component, its chat
// composer, its entry row, the chat and scroll hooks factored
// out of it, and the scroll decisions.
export const NARRATION_FEED_FILES = [
  "AgentNarrationFeed.tsx",
  "AgentChatComposer.tsx",
  "AgentFeedEntryRow.tsx",
  "useAgentChat.ts",
  "useFeedScroll.ts",
  "feedScroll.ts",
] as const;

export function readNarrationFeed(): string {
  return readDashboardFiles(NARRATION_FEED_FILES);
}
