import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readNarrationFeed } from "./helpers/source";
import { AgentNarrationFeed } from "../apps/dashboard/src/AgentNarration.tsx";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";
import {
  emptyNarrationState,
  type NarrationEntry,
} from "../apps/dashboard/src/agentNarration.ts";
import { persistNarration } from "../apps/dashboard/src/narrationStorage.ts";

const stopped = {
  status: "STOPPED",
  decision: null,
  events: [],
  candidates: [],
} as unknown as OperationsSnapshot;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("narration feed: message order", () => {
  it("renders entries oldest first, newest at the bottom", () => {
    // Seed the device-local narration store with a two-entry
    // exchange; the feed's initial state restores from it.
    const older: NarrationEntry = {
      id: "narration:1",
      at: 1_700_000_000_000,
      kind: "chatUser",
      text: "古い質問です",
    };
    const newer: NarrationEntry = {
      id: "narration:2",
      at: 1_700_000_060_000,
      kind: "chatReply",
      text: "新しい返信です",
    };
    const storage = memoryStorage();
    persistNarration(
      { ...emptyNarrationState(), entries: [older, newer], nextEntryId: 3 },
      storage,
    );
    vi.stubGlobal("window", { localStorage: storage });

    const html = renderToStaticMarkup(
      <AgentNarrationFeed data={stopped} stale={false} />,
    );
    const olderAt = html.indexOf("古い質問です");
    const newerAt = html.indexOf("新しい返信です");
    expect(olderAt).toBeGreaterThanOrEqual(0);
    expect(newerAt).toBeGreaterThan(olderAt);
  });

  it("wires the jump pill and the stick management into the feed", () => {
    const component = readNarrationFeed();
    expect(component).toContain("最新の実況へ");
    expect(component).toContain("agent-feed-jump");
    expect(component).toContain("isStuckToFeedBottom");
    expect(component).toContain("feedJumpVisible");
    // Reduced motion turns the jump's smooth scroll off.
    expect(component).toContain('reducedMotion ? "auto" : "smooth"');
  });
});
