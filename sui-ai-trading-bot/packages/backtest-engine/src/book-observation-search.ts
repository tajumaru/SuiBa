/** Upper bound preserves the latest failed observation; never searches for latest healthy. */
export function observationAt<T extends { observedAt: number }>(
  observations: readonly T[],
  now: number,
): T | undefined {
  let low = 0,
    high = observations.length;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if (observations[mid].observedAt <= now) low = mid + 1;
    else high = mid;
  }
  return observations[low - 1];
}
