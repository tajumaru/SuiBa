import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readNarrationFeed } from "./helpers/source";
import { AgentNarrationFeed } from "../apps/dashboard/src/AgentNarration.tsx";
import { AgentFeedEntryRow } from "../apps/dashboard/src/AgentFeedEntryRow.tsx";
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
  it("renders the Walrus background only for memory entries", () => {
    const memory: NarrationEntry = {
      id: "narration:1",
      at: 1_700_000_000_000,
      kind: "memory",
      text: "記憶の実況です",
    };
    const ordinary: NarrationEntry = {
      ...memory,
      id: "narration:2",
      kind: "cycle",
      text: "通常の実況です",
    };

    const memoryHtml = renderToStaticMarkup(
      <AgentFeedEntryRow entry={memory} />,
    );
    const ordinaryHtml = renderToStaticMarkup(
      <AgentFeedEntryRow entry={ordinary} />,
    );
    expect(memoryHtml).toContain('class="agent-feed-memory-bg"');
    expect(memoryHtml).toContain('src="/walrus-memory-bg.png"');
    expect(memoryHtml).toContain('alt=""');
    expect(memoryHtml).toContain('aria-hidden="true"');
    expect(ordinaryHtml).not.toContain("agent-feed-memory-bg");
  });

  it("seals only eligible memory entries", () => {
    const memory: NarrationEntry = {
      id: "narration:10",
      at: 1_700_000_000_000,
      kind: "memory",
      text: "記憶の実況です",
    };
    const sealed = renderToStaticMarkup(
      <AgentFeedEntryRow
        entry={memory}
        memorySealed
        onOpenMemorySeal={() => {}}
      />,
    );
    const opened = renderToStaticMarkup(
      <AgentFeedEntryRow
        entry={memory}
        memorySealed={false}
        onOpenMemorySeal={() => {}}
      />,
    );
    const ordinary = renderToStaticMarkup(
      <AgentFeedEntryRow
        entry={{ ...memory, kind: "cycle" }}
        memorySealed
        onOpenMemorySeal={() => {}}
      />,
    );
    expect(sealed).toContain(`data-memory-seal="${memory.id}"`);
    expect(opened).not.toContain("data-memory-seal");
    expect(ordinary).not.toContain("data-memory-seal");
  });

  it("does not seal memory entries from before feature enablement", () => {
    const storage = memoryStorage();
    const entry: NarrationEntry = {
      id: "narration:10",
      at: 1_700_000_000_000,
      kind: "memory",
      text: "以前からある記憶です",
    };
    persistNarration(
      {
        ...emptyNarrationState(),
        entries: [entry],
        memorySealEnabledAt: entry.at + 1,
      },
      storage,
    );
    vi.stubGlobal("window", { localStorage: storage });
    const html = renderToStaticMarkup(
      <AgentNarrationFeed data={stopped} stale={false} />,
    );
    expect(html).not.toContain("data-memory-seal");
  });

  it("keeps an opened eligible memory entry unsealed", () => {
    const storage = memoryStorage();
    const entry: NarrationEntry = {
      id: "narration:11",
      at: 1_700_000_000_000,
      kind: "memory",
      text: "開封済みの記憶です",
    };
    persistNarration(
      {
        ...emptyNarrationState(),
        entries: [entry],
        memorySealEnabledAt: entry.at,
        openedMemorySealIds: [entry.id],
      },
      storage,
    );
    vi.stubGlobal("window", { localStorage: storage });
    const html = renderToStaticMarkup(
      <AgentNarrationFeed data={stopped} stale={false} />,
    );
    expect(html).not.toContain("data-memory-seal");
  });

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
