import { describe, expect, it, vi } from "vitest";
import type { NarrationEntry } from "../apps/dashboard/src/agentNarration.ts";
import {
  compareNarrationPage,
  emptyNarrationShadowDiagnostics,
  NarrationShadowReader,
  NARRATION_SHADOW_ENABLED_KEY,
  type ServerNarrationEntry,
} from "../apps/dashboard/src/narrationShadow.ts";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const server = (
  seq: number,
  id = `id-${seq}`,
  kind: ServerNarrationEntry["kind"] = "cycle",
) =>
  ({
    seq,
    id,
    pair: "SUI_USDC",
    kind,
    occurredAt: seq * 1000,
    json: { text: `text-${seq}` },
  }) satisfies ServerNarrationEntry;
const device = (
  id: string,
  kind: NarrationEntry["kind"],
  at: number,
  text = `text-${at / 1000}`,
) => ({ id, kind, at, text }) satisfies NarrationEntry;

describe("narration read shadow", () => {
  it("starts from the latest window when no cursor has been stored", async () => {
    const storage = new MemoryStorage();
    const api = vi.fn().mockResolvedValue({
      schema: 1,
      pair: "SUI_USDC",
      entries: [],
      nextSince: null,
      hasMore: false,
    });
    await new NarrationShadowReader(api, "SUI_USDC", storage).poll([]);
    expect(api).toHaveBeenCalledWith("narration?pair=SUI_USDC&limit=100");
  });

  it("persists the exclusive cursor and resumes without requesting duplicates", async () => {
    const storage = new MemoryStorage();
    const firstApi = vi.fn().mockResolvedValue({
      schema: 1,
      pair: "SUI_USDC",
      entries: [server(7)],
      nextSince: 7,
      hasMore: false,
    });
    await new NarrationShadowReader(firstApi, "SUI_USDC", storage).poll([]);
    const secondApi = vi.fn().mockResolvedValue({
      schema: 1,
      pair: "SUI_USDC",
      entries: [server(8)],
      nextSince: 8,
      hasMore: false,
    });
    const result = await new NarrationShadowReader(
      secondApi,
      "SUI_USDC",
      storage,
    ).poll([]);
    expect(secondApi).toHaveBeenCalledWith(
      "narration?pair=SUI_USDC&since=7&limit=100",
    );
    expect(result.cursor).toBe(8);
    expect(result.cursorDuplicate).toBe(0);
  });

  it("records a 410 and reloads the latest window", async () => {
    const storage = new MemoryStorage();
    storage.setItem("suiba.narration.shadow-read.cursor.v1:SUI_USDC", "4");
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error("NARRATION_CURSOR_EXPIRED"))
      .mockResolvedValueOnce({
        schema: 1,
        pair: "SUI_USDC",
        entries: [server(20)],
        nextSince: 20,
        hasMore: false,
      });
    const result = await new NarrationShadowReader(
      api,
      "SUI_USDC",
      storage,
    ).poll([]);
    expect(api.mock.calls[1][0]).toBe("narration?pair=SUI_USDC&limit=100");
    expect(result.cursorExpired).toBe(1);
    expect(result.cursor).toBe(20);
  });

  it("isolates API failures and can be stopped with the local flag", async () => {
    const storage = new MemoryStorage();
    const api = vi.fn().mockRejectedValue(new Error("HTTP_503"));
    const reader = new NarrationShadowReader(api, "SUI_USDC", storage);
    expect((await reader.poll([])).lastError).toBe("HTTP_503");
    storage.setItem(NARRATION_SHADOW_ENABLED_KEY, "false");
    expect((await reader.poll([])).enabled).toBe(false);
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("excludes all six device-only kinds from missing-server differences", () => {
    const local = [
      "sleepTalk",
      "chatUser",
      "chatReply",
      "chatPrompt",
      "greeting",
      "status",
    ].map((kind, index) =>
      device(`local-${index}`, kind as NarrationEntry["kind"], 1000),
    );
    const result = compareNarrationPage(
      emptyNarrationShadowDiagnostics("SUI_USDC"),
      [server(1, "shared")],
      [device("shared", "cycle", 1000), ...local],
    );
    expect(result.deviceOnly).toBe(0);
    expect(result.serverOnly).toBe(0);
  });
});
