import type { Candle } from "./index.ts";
import { sha256Hex } from "./sha256.ts";
export function canonicalFrame(candles: Candle[]) {
  return JSON.stringify(
    candles.map((c) => [
      c.timestamp,
      c.timeframe,
      c.source,
      c.open,
      c.high,
      c.low,
      c.close,
      c.volume,
      c.provenance ? { ...c.provenance, fetchedAt: undefined } : null,
    ]),
  );
}
export async function browserDigest(text: string) {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    // Non-secure contexts (e.g. the dashboard over plain HTTP on a LAN
    // address) expose no SubtleCrypto; use the bundled SHA-256 so the
    // digest-verified dashboard fetches keep working there.
    return sha256Hex(bytes);
  }
  const hash = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
