import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserDigest } from "../packages/shared/src/dashboard-wire.ts";
import { sha256Hex } from "../packages/shared/src/sha256.ts";

function nodeDigest(text: string) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA256 =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const PANGRAM = "The quick brown fox jumps over the lazy dog";
const PANGRAM_SHA256 =
  "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592";

describe("browserDigest fallback (no SubtleCrypto, non-secure context)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function withoutSubtle() {
    // A non-secure context (plain HTTP on a non-localhost address)
    // exposes a Crypto object with no subtle member, or none at all.
    vi.stubGlobal("crypto", {});
  }

  it("matches the known SHA-256 of the empty string", async () => {
    withoutSubtle();
    expect(await browserDigest("")).toBe(EMPTY_SHA256);
  });

  it("matches the known SHA-256 of 'abc'", async () => {
    withoutSubtle();
    expect(await browserDigest("abc")).toBe(ABC_SHA256);
  });

  it("matches the known SHA-256 of the pangram", async () => {
    withoutSubtle();
    expect(await browserDigest(PANGRAM)).toBe(PANGRAM_SHA256);
  });

  it("matches node:crypto at the padding boundaries", async () => {
    withoutSubtle();
    for (const length of [55, 56, 64]) {
      const text = "a".repeat(length);
      expect(await browserDigest(text)).toBe(nodeDigest(text));
    }
  });

  it("matches node:crypto for multi-byte UTF-8 input", async () => {
    withoutSubtle();
    const text = "チャート・履歴の更新に失敗しました";
    expect(await browserDigest(text)).toBe(nodeDigest(text));
  });

  it("matches node:crypto for a large input", async () => {
    withoutSubtle();
    const text = "0123456789abcdef".repeat(10_000);
    expect(text.length).toBeGreaterThanOrEqual(100_000);
    expect(await browserDigest(text)).toBe(nodeDigest(text));
  });
});

describe("sha256Hex", () => {
  it("matches node:crypto across block and padding boundaries", () => {
    const encoder = new TextEncoder();
    for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 1000]) {
      const bytes = encoder.encode("a".repeat(length));
      expect(sha256Hex(bytes)).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
  });
});

describe("browserDigest native path (SubtleCrypto present)", () => {
  it("uses crypto.subtle when it is available", async () => {
    const spy = vi.spyOn(globalThis.crypto.subtle, "digest");
    try {
      expect(await browserDigest("abc")).toBe(ABC_SHA256);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("agrees with the fallback on the same inputs", async () => {
    expect(await browserDigest(PANGRAM)).toBe(PANGRAM_SHA256);
    expect(await browserDigest("")).toBe(EMPTY_SHA256);
  });
});
