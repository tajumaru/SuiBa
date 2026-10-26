import { describe, expect, it } from "vitest";
import {
  appendPatternDot,
  clearEnrollment,
  enrollPattern,
  isDismissed,
  isEnrolled,
  isPatternLockSupported,
  isValidPattern,
  loadEnrollment,
  patternKey,
  setDismissed,
  unlockWithPattern,
  type PatternLockEnv,
  type PatternLockStorage,
} from "../apps/dashboard/src/patternLock.ts";

function memoryStorage(): PatternLockStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function env(storage: PatternLockStorage = memoryStorage()): PatternLockEnv {
  return { storage, crypto: globalThis.crypto };
}

describe("pattern sequence rules", () => {
  it("appends dots in trace order and ignores repeats", () => {
    expect(appendPatternDot([], 4)).toEqual([4]);
    expect(appendPatternDot([4], 4)).toEqual([4]);
    expect(appendPatternDot([4, 0], 8)).toEqual([4, 0, 8]);
  });

  it("includes a jumped-over middle dot, Android style", () => {
    expect(appendPatternDot([0], 2)).toEqual([0, 1, 2]);
    expect(appendPatternDot([0], 8)).toEqual([0, 4, 8]);
    expect(appendPatternDot([6], 2)).toEqual([6, 4, 2]);
    // An already-visited middle dot is not duplicated.
    expect(appendPatternDot([4, 0], 8)).toEqual([4, 0, 8]);
    // A knight's move has no middle dot.
    expect(appendPatternDot([0], 7)).toEqual([0, 7]);
  });

  it("rejects out-of-range dots without changing the sequence", () => {
    expect(appendPatternDot([1], 9)).toEqual([1]);
    expect(appendPatternDot([1], -1)).toEqual([1]);
  });

  it("validates length, range and uniqueness", () => {
    expect(isValidPattern([0, 1, 2])).toBe(false);
    expect(isValidPattern([0, 1, 2, 5])).toBe(true);
    expect(isValidPattern([0, 1, 2, 2])).toBe(false);
    expect(isValidPattern([0, 1, 2, 9])).toBe(false);
    expect(patternKey([0, 4, 8, 7])).toBe("0-4-8-7");
  });
});

describe("pattern enrolment storage", () => {
  it("round-trips the token through enrol and unlock", async () => {
    const e = env();
    await enrollPattern([0, 4, 8, 7], "secret-token-123", e);
    expect(isEnrolled(e)).toBe(true);
    await expect(unlockWithPattern([0, 4, 8, 7], e)).resolves.toBe(
      "secret-token-123",
    );
  });

  it("refuses a wrong pattern without throwing", async () => {
    const e = env();
    await enrollPattern([0, 4, 8, 7], "secret-token-123", e);
    await expect(unlockWithPattern([0, 4, 8, 6], e)).resolves.toBeNull();
    await expect(unlockWithPattern([1, 2, 3, 5], e)).resolves.toBeNull();
  });

  it("stores ciphertext only — neither token nor pattern is readable", async () => {
    const storage = memoryStorage();
    const e = env(storage);
    await enrollPattern([0, 4, 8, 7], "secret-token-123", e);
    const raw = storage.getItem("suiba.patternLock.v1") ?? "";
    expect(raw).not.toContain("secret-token-123");
    expect(raw).not.toContain("0-4-8-7");
    const record = loadEnrollment(e);
    expect(record?.v).toBe(1);
    expect(record?.salt.length).toBeGreaterThan(0);
  });

  it("clears the enrolment and reports support honestly", async () => {
    const e = env();
    expect(isPatternLockSupported(e)).toBe(true);
    await enrollPattern([2, 5, 8, 7], "tok", e);
    clearEnrollment(e);
    expect(isEnrolled(e)).toBe(false);
    await expect(unlockWithPattern([2, 5, 8, 7], e)).resolves.toBeNull();
    expect(isPatternLockSupported({ storage: null, crypto: null })).toBe(
      false,
    );
    expect(loadEnrollment({ storage: null })).toBeNull();
  });

  it("rejects an invalid pattern at enrolment", async () => {
    const e = env();
    await expect(enrollPattern([0, 1, 2], "tok", e)).rejects.toThrow(
      "INVALID_PATTERN",
    );
    expect(isEnrolled(e)).toBe(false);
  });

  it("tracks the dismissed flag independently of enrolment", () => {
    const e = env();
    expect(isDismissed(e)).toBe(false);
    setDismissed(e);
    expect(isDismissed(e)).toBe(true);
    expect(isEnrolled(e)).toBe(false);
  });

  it("treats a corrupt stored record as no enrolment", async () => {
    const storage = memoryStorage();
    storage.setItem("suiba.patternLock.v1", "{broken json");
    const e = env(storage);
    expect(loadEnrollment(e)).toBeNull();
    await expect(unlockWithPattern([0, 1, 2, 3], e)).resolves.toBeNull();
    storage.setItem(
      "suiba.patternLock.v1",
      JSON.stringify({ v: 1, salt: "@@", iv: "@@", data: "@@" }),
    );
    await expect(unlockWithPattern([0, 1, 2, 3], e)).resolves.toBeNull();
  });
});
