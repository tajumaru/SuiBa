/** Removal-only migration for the retired pattern-token storage.
 * Never decrypt, parse, copy or rewrite legacy credentials. No WebCrypto required.
 */
export interface PatternLockStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}
export type PatternMigrationResult = "removed" | "empty" | "failed";
const LEGACY_KEYS = [
  "suiba.patternLock.v1",
  "suiba.patternLock.dismissed",
  "suiba.patternLock.probe",
] as const;

export function removeLegacyPatternLock(
  storage?: PatternLockStorage | null,
): PatternMigrationResult {
  try {
    storage = storage === undefined ? globalThis.localStorage : storage;
  } catch {
    return "failed";
  }
  if (!storage) return "failed";
  let removed = false;
  let failed = false;
  for (const key of LEGACY_KEYS) {
    // Attempt removal even if reading is refused; keep trying the other keys.
    try {
      removed = storage.getItem(key) !== null || removed;
    } catch {
      failed = true;
    }
    try {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) failed = true;
    } catch {
      failed = true;
    }
  }
  return failed ? "failed" : removed ? "removed" : "empty";
}
