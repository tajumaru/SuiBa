import { describe, expect, it } from "vitest";
import {
  AGENT_CHARACTER_KEY,
  loadAgentCharacter,
  saveAgentCharacter,
  subscribeAgentCharacter,
} from "../apps/dashboard/src/agentCharacter.ts";
import { agentDisplayName } from "../apps/dashboard/src/agentName.ts";
import {
  FIZH_POSE_IMAGE,
  PEN_POSE_IMAGE,
  POSE_IMAGE,
  artworkFor,
} from "../apps/dashboard/src/AgentHeaderAvatar.tsx";
import type { AgentPose } from "../apps/dashboard/src/agentNarration.ts";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

const POSES: AgentPose[] = [
  "normal",
  "point",
  "pointSmile",
  "sleep",
  "laptop",
  "buyLine",
];

describe("agent character storage", () => {
  it("defaults to the white character and round-trips pen", () => {
    const storage = fakeStorage();
    expect(loadAgentCharacter(storage)).toBe("white");
    saveAgentCharacter("pen", storage);
    expect(storage.getItem(AGENT_CHARACTER_KEY)).toBe("pen");
    expect(loadAgentCharacter(storage)).toBe("pen");
    saveAgentCharacter("white", storage);
    expect(loadAgentCharacter(storage)).toBe("white");
  });

  it("round-trips fizh", () => {
    const storage = fakeStorage();
    saveAgentCharacter("fizh", storage);
    expect(storage.getItem(AGENT_CHARACTER_KEY)).toBe("fizh");
    expect(loadAgentCharacter(storage)).toBe("fizh");
  });

  it("treats anything unreadable as the white character", () => {
    expect(loadAgentCharacter(fakeStorage({ [AGENT_CHARACTER_KEY]: "junk" })))
      .toBe("white");
    expect(loadAgentCharacter(null)).toBe("white");
  });

  it("notifies subscribers on save until they unsubscribe", () => {
    const seen: string[] = [];
    const off = subscribeAgentCharacter((c) => seen.push(c));
    saveAgentCharacter("pen", fakeStorage());
    off();
    saveAgentCharacter("white", fakeStorage());
    expect(seen).toEqual(["pen"]);
  });
});

describe("agent display name defaults", () => {
  it("uses the character's own default while unnamed", () => {
    expect(agentDisplayName("")).toBe("キャラ");
    expect(agentDisplayName("", "white")).toBe("キャラ");
    expect(agentDisplayName("", "pen")).toBe("ぺんちゃん");
    expect(agentDisplayName("", "fizh")).toBe("King Fizh");
  });

  it("a custom name wins for either character", () => {
    expect(agentDisplayName("シロ", "pen")).toBe("シロ");
    expect(agentDisplayName("シロ", "white")).toBe("シロ");
    expect(agentDisplayName("シロ", "fizh")).toBe("シロ");
  });
});

describe("artwork selection", () => {
  it("gives ぺんちゃん its own artwork for every pose", () => {
    for (const pose of POSES) {
      expect(artworkFor("pen", pose, false).main).toBe(PEN_POSE_IMAGE[pose]);
      expect(PEN_POSE_IMAGE[pose]).toContain("agent-pen-");
    }
  });

  it("pairs the pen laptop with its typing frame and ignores hard mode", () => {
    const art = artworkFor("pen", "laptop", true);
    expect(art.main).toBe(PEN_POSE_IMAGE.laptop);
    expect(art.typing).toContain("agent-pen-laptop-typing");
    expect(artworkFor("pen", "normal", false).typing).toBeNull();
  });

  it("gives Sui King Fizh its own artwork for every pose", () => {
    for (const pose of POSES) {
      expect(artworkFor("fizh", pose, false).main).toBe(FIZH_POSE_IMAGE[pose]);
      expect(FIZH_POSE_IMAGE[pose]).toContain("agent-fizh-");
    }
    const art = artworkFor("fizh", "laptop", true);
    expect(art.main).toBe(FIZH_POSE_IMAGE.laptop);
    expect(art.typing).toContain("agent-fizh-laptop-typing");
    expect(artworkFor("fizh", "normal", false).typing).toBeNull();
  });

  it("keeps the white set and its hard variants exactly as before", () => {
    for (const pose of POSES)
      expect(artworkFor("white", pose, false).main).toBe(POSE_IMAGE[pose]);
    expect(artworkFor("white", "sleep", false).main).toBe(POSE_IMAGE.sleep);
    expect(artworkFor("white", "buyLine", false).main).toBe(POSE_IMAGE.buyLine);
    expect(artworkFor("white", "laptop", false).typing).toContain(
      "agent-white-laptop-typing",
    );
    expect(artworkFor("white", "normal", true).main).toContain("agent-hard.");
    expect(artworkFor("white", "laptop", true).typing).toContain(
      "agent-hard-guitar-2",
    );
    // Sleep and the blue line keep their own artwork in hard mode.
    expect(artworkFor("white", "sleep", true).main).toBe(POSE_IMAGE.sleep);
    expect(artworkFor("white", "buyLine", true).main).toBe(POSE_IMAGE.buyLine);
  });
});
