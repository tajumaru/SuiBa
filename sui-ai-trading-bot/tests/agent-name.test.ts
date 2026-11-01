import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import {
  agentDisplayName,
  loadAgentName,
  sanitizeAgentName,
  saveAgentName,
} from "../apps/dashboard/src/agentName.ts";
import { AgentHeaderAvatar } from "../apps/dashboard/src/AgentNarration.tsx";
import { bootLines } from "../apps/dashboard/src/BootScreen.tsx";

describe("agent name", () => {
  it("sanitises: trims, collapses whitespace, drops controls, caps at 10", () => {
    expect(sanitizeAgentName("  しずく  ")).toBe("しずく");
    expect(sanitizeAgentName("すい\nちゃん")).toBe("すい ちゃん");
    expect(sanitizeAgentName("あいうえおかきくけこさ")).toBe("あいうえおかきくけこ");
    expect(sanitizeAgentName(42)).toBe("");
    expect(sanitizeAgentName("")).toBe("");
  });

  it("falls back to キャラ for display only", () => {
    expect(agentDisplayName("")).toBe("キャラ");
    expect(agentDisplayName("しずく")).toBe("しずく");
  });

  it("round-trips through storage, sanitised", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    saveAgentName(" しずく ", storage);
    expect(loadAgentName(storage)).toBe("しずく");
    saveAgentName("", storage);
    expect(loadAgentName(storage)).toBe("");
    expect(loadAgentName(null)).toBe("");
  });

  it("the header avatar offers renaming only with a handler", () => {
    const withHandler = renderToStaticMarkup(
      React.createElement(AgentHeaderAvatar, {
        pose: "normal",
        agentName: "しずく",
        onRename: () => {},
      }),
    );
    expect(withHandler).toContain("しずくの名前を変える");
    expect(withHandler).toContain("agent-avatar-tap");
    const without = renderToStaticMarkup(
      React.createElement(AgentHeaderAvatar, { pose: "normal" }),
    );
    expect(without).not.toContain("agent-avatar-tap");
  });

  it("the boot character line carries the name when set", () => {
    const named = bootLines({
      pairLabel: "SUI / USDC",
      api: "ok",
      bot: "running",
      agentName: "しずく",
    });
    expect(named.find((l) => l.key === "character")?.value).toBe(
      "しずく ready",
    );
    const plain = bootLines({
      pairLabel: "SUI / USDC",
      api: "ok",
      bot: "running",
    });
    expect(plain.find((l) => l.key === "character")?.value).toBe("ready");
  });
});
