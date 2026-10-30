import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentFeedEntryRow,
  AgentNarrationFeed,
} from "../apps/dashboard/src/AgentNarration.tsx";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";
import type { NarrationEntry } from "../apps/dashboard/src/agentNarration.ts";

const stopped = {
  status: "STOPPED",
  decision: null,
  events: [],
  candidates: [],
} as unknown as OperationsSnapshot;

describe("agent chat UI (static rendering)", () => {
  it("renders the chat box with the base chips and the comment form", () => {
    const html = renderToStaticMarkup(
      <AgentNarrationFeed data={stopped} stale={false} />,
    );
    expect(html).toContain("キャラへの質問候補");
    expect(html).toContain("なんで買わないの？");
    expect(html).toContain("がんばれ");
    expect(html).toContain('aria-label="キャラへのコメント"');
    expect(html).toContain("送信");
    // The live region for replies starts empty.
    expect(html).toContain('role="status"');
  });

  it("renders a milestone prompt with its tappable question chip", () => {
    const entry: NarrationEntry = {
      id: "narration:1",
      at: 1_700_000_000_000,
      kind: "chatPrompt",
      text: "ライン立ったよ。届くまでどれくらいか、聞く？",
      promptChip: "ラインまでどれくらい？",
    };
    const html = renderToStaticMarkup(
      <AgentFeedEntryRow entry={entry} onPromptChip={() => {}} />,
    );
    expect(html).toContain("キャラ");
    expect(html).toContain("agent-feed-prompt-chip");
    expect(html).toContain("ラインまでどれくらい？");
    // Without a handler (e.g. a restored prompt), no dead button.
    const bare = renderToStaticMarkup(<AgentFeedEntryRow entry={entry} />);
    expect(bare).not.toContain("agent-feed-prompt-chip");
  });

  it("tags the user's comments and the character's replies", () => {
    const user: NarrationEntry = {
      id: "narration:2",
      at: 1_700_000_000_000,
      kind: "chatUser",
      text: "調子は？",
    };
    const reply: NarrationEntry = {
      id: "narration:3",
      at: 1_700_000_000_000,
      kind: "chatReply",
      text: "宣言6回で、的中3・外れ2。",
      topic: "score",
    };
    expect(renderToStaticMarkup(<AgentFeedEntryRow entry={user} />)).toContain(
      "あなた",
    );
    expect(
      renderToStaticMarkup(<AgentFeedEntryRow entry={reply} />),
    ).toContain("返信");
  });
});
