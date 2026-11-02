/**
 * Epoch boundary marks for the narration feed. The worker's
 * chain sampler reports the current Sui epoch; when it advances
 * past the last epoch this device has seen, the feed records
 * one line — the chain's own daily milestone joining the bot's
 * day. The first sighting only records (the epoch began long
 * before the app noticed), so a mark is minted solely for a
 * boundary the device actually witnessed.
 */
const KEY = "suiba.lastEpoch";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

/** The epoch to announce, or null when nothing began. */
export function epochTransition(
  seen: number | null,
  current: number,
): number | null {
  return seen != null && current > seen ? current : null;
}

export function loadLastEpoch(storage?: StorageAccess): number | null {
  try {
    const raw = (storage ?? window.localStorage).getItem(KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export function saveLastEpoch(epoch: number, storage?: StorageAccess): void {
  try {
    (storage ?? window.localStorage).setItem(KEY, String(epoch));
  } catch {
    // A denied storage just means the next visit re-records.
  }
}
