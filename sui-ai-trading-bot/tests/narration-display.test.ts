import { describe, expect, it } from "vitest";
import type { NarrationEntry } from "../apps/dashboard/src/agentNarration.ts";
import { findNewLatestEntryIds } from "../apps/dashboard/src/AgentNarrationFeed.tsx";
import {
  NARRATION_SERVER_DISPLAY_ENABLED_KEY,
  selectDisplayEntries,
  serverDisplayEnabled,
} from "../apps/dashboard/src/narrationServerDisplay.ts";
import type { ServerNarrationEntry } from "../apps/dashboard/src/narrationShadow.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
}

const device = (
  id: string,
  kind: NarrationEntry["kind"],
  text: string,
  at = 1000,
) => ({ id, kind, text, at }) satisfies NarrationEntry;

const server = (
  id: string,
  kind: ServerNarrationEntry["kind"],
  text: string,
  occurredAt = 1000,
) =>
  ({
    seq: 1,
    id,
    pair: "SUI_USDC",
    kind,
    occurredAt,
    json: { text },
  }) satisfies ServerNarrationEntry;

describe("server narration display switch", () => {
  it("uses server entries for server kinds by default", () => {
    const storage = new MemoryStorage();
    expect(serverDisplayEnabled(storage)).toBe(true);
    expect(
      selectDisplayEntries(
        [device("device", "cycle", "device text")],
        [server("server", "cycle", "server text")],
        serverDisplayEnabled(storage),
      ),
    ).toEqual([expect.objectContaining({ id: "server", text: "server text" })]);
  });

  it('returns to device entries when the flag is "false"', () => {
    const storage = new MemoryStorage();
    storage.values.set(NARRATION_SERVER_DISPLAY_ENABLED_KEY, "false");
    expect(serverDisplayEnabled(storage)).toBe(false);
    expect(
      selectDisplayEntries(
        [device("device", "cycle", "device text")],
        [server("server", "cycle", "server text")],
        serverDisplayEnabled(storage),
      ),
    ).toEqual([device("device", "cycle", "device text")]);
  });

  it("keeps all device-only kinds from the device feed", () => {
    const entries = [
      "sleepTalk",
      "chatUser",
      "chatReply",
      "chatPrompt",
      "greeting",
      "status",
    ].map((kind, index) =>
      device(`device-${index}`, kind as NarrationEntry["kind"], kind, index),
    );
    expect(selectDisplayEntries(entries, [], true)).toEqual(entries);
  });

  it("does not queue the initial server window as new arrivals", () => {
    const initialWindow = selectDisplayEntries(
      [],
      [server("server", "cycle", "server text")],
      true,
    );
    expect(findNewLatestEntryIds(new Set(), initialWindow, false)).toEqual(
      new Set(),
    );
  });
});
