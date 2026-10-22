import type { Candle } from "./index.ts";
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
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
