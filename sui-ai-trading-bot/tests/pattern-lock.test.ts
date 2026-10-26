import { expect, it } from "vitest";
import {
  removeLegacyPatternLock,
  type PatternLockStorage,
} from "../apps/dashboard/src/patternLock.ts";
const keys = [
  "suiba.patternLock.v1",
  "suiba.patternLock.dismissed",
  "suiba.patternLock.probe",
];
function fixture() {
  const data = new Map(keys.map((k) => [k, "legacy"]));
  data.set("unrelated", "keep");
  const storage: PatternLockStorage = {
    getItem: (k) => data.get(k) ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
  };
  return { data, storage };
}
it("removes all old data without parsing ciphertext and preserves unrelated data", () => {
  const { data, storage } = fixture();
  data.set(keys[0], "{invalid JSON");
  expect(removeLegacyPatternLock(storage)).toBe("removed");
  expect([...data]).toEqual([["unrelated", "keep"]]);
  expect(removeLegacyPatternLock(storage)).toBe("empty");
});
it("attempts all deletions after a failure and permits retry", () => {
  const { data, storage } = fixture();
  let refuse = true;
  const failing = {
    ...storage,
    removeItem: (key: string) => {
      if (key === keys[0] && refuse) throw Error("denied");
      storage.removeItem(key);
    },
  };
  expect(removeLegacyPatternLock(failing)).toBe("failed");
  expect(data.has(keys[1])).toBe(false);
  refuse = false;
  expect(removeLegacyPatternLock(failing)).toBe("removed");
  expect(data.has(keys[0])).toBe(false);
});
it("does not claim success if removal silently fails", () => {
  const { storage } = fixture();
  expect(removeLegacyPatternLock({ ...storage, removeItem: () => {} })).toBe(
    "failed",
  );
});
it("still attempts deletion when reads fail; blocked Safari storage does not throw", () => {
  let calls = 0;
  expect(
    removeLegacyPatternLock({
      getItem: () => {
        throw Error("SecurityError");
      },
      removeItem: () => {
        calls++;
      },
    }),
  ).toBe("failed");
  expect(calls).toBe(3);
  expect(removeLegacyPatternLock(null)).toBe("failed");
});
