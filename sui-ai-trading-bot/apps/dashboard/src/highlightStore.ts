import { z } from "zod";
import type { NarrationEntry, NarrationState } from "./agentNarration.ts";

/**
 * Highlights: the shareable moments of the feed — a buy or sell
 * fill, a watch hit, a near miss, a buy-run line reached, sell
 * lines declared, a forecast verdict — bookmarked automatically
 * as they happen, with the feed entries around them and the
 * recent price path, so the moment can be REPLAYED later (and
 * screen-recorded for sharing) instead of being lost the way
 * the first fill was.
 *
 * A moment is captured only while it is fresh (within ten
 * minutes of occurring): opening the app long afterwards lays
 * down the recorded history, whose price context no longer
 * matches, and must not mint "highlights" out of it. Storage is
 * device-local and per pair, like the narration itself.
 */
export interface HighlightEntry {
  id: string;
  at: number;
  kind: string;
  text: string;
  side?: "BUY" | "SELL";
}

export interface Highlight {
  /** The id of the narration entry that was the moment. */
  id: string;
  at: number;
  kind: string;
  side?: "BUY" | "SELL";
  /** The moment's own entry text (the list label). */
  title: string;
  /** Up to eight entries ending at the moment, oldest first.
   * A watchHit or a forecast verdict may carry one more: its
   * declaration, prepended when it fell outside the window
   * (see captureHighlights). */
  entries: HighlightEntry[];
  /** The recent price path at capture time (the feed's own
   * decision-price window), for the replay's sparkline. */
  prices: number[];
}

export const MAX_HIGHLIGHTS = 30;
export const HIGHLIGHT_FRESH_MS = 600000;
const ENTRIES_AROUND = 8;

/**
 * Per-kind caps inside the store. A trending day can mint a
 * watch hit every few minutes; under a single global cap the
 * flood evicts the rare moments (a fill, a line reached) the
 * highlights exist for, and the chip strip sprawls into one
 * long row of 的中. Each kind now keeps only its newest few,
 * evicting its own kind first. The per-kind caps may sum past
 * MAX_HIGHLIGHTS; the global cap in capHighlights is the final
 * bound on the store.
 */
export const HIGHLIGHT_KIND_CAPS: Record<string, number> = {
  trade: 10,
  watchHit: 6,
  nearMiss: 6,
  priceLineReached: 4,
  sellLine: 4,
  forecastHit: 3,
  forecastMiss: 3,
};

/** Trim a list to the per-kind caps (then the global cap),
 * keeping each kind's newest. Order stays chronological. */
export function capHighlights(list: Highlight[]): Highlight[] {
  const sorted = [...list].sort((a, b) => a.at - b.at);
  const counts = new Map<string, number>();
  const keptReversed: Highlight[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const h = sorted[i];
    const cap = HIGHLIGHT_KIND_CAPS[h.kind] ?? MAX_HIGHLIGHTS;
    const n = counts.get(h.kind) ?? 0;
    if (n >= cap) continue;
    counts.set(h.kind, n + 1);
    keptReversed.push(h);
  }
  return keptReversed.reverse().slice(-MAX_HIGHLIGHTS);
}

export function isHighlightEntry(entry: NarrationEntry): boolean {
  return (
    entry.kind === "trade" ||
    entry.kind === "watchHit" ||
    entry.kind === "nearMiss" ||
    entry.kind === "priceLineReached" ||
    entry.kind === "sellLine" ||
    entry.kind === "forecastHit" ||
    entry.kind === "forecastMiss"
  );
}

export function highlightLabel(h: Pick<Highlight, "kind" | "side">): string {
  switch (h.kind) {
    case "trade":
      return h.side === "SELL" ? "売り約定" : "買えた！";
    case "watchHit":
      return "的中";
    case "nearMiss":
      return "ニアミス";
    case "priceLineReached":
      return "ライン到達";
    case "sellLine":
      return "売りライン";
    case "forecastHit":
      return "予測的中";
    case "forecastMiss":
      return "予測外れ";
    default:
      return "ハイライト";
  }
}

const slim = (e: NarrationEntry): HighlightEntry => ({
  id: e.id,
  at: e.at,
  kind: e.kind,
  text: e.text,
  ...(e.side ? { side: e.side } : {}),
});

/**
 * The declaration behind a watchHit. Declarations are the only
 * entries that open 「次は○○を見てる」 (declareWatchText), and a
 * hit opens with its condition's short name (hitWatchText), so
 * the pairing is recoverable from the texts themselves. Watches
 * are serial — one at a time, settled before the next is
 * declared — so the nearest preceding declaration OF THE SAME
 * CONDITION is the promise this hit kept. The scan stops at any
 * settlement (a hit or a near miss): a declaration older than
 * that already met its own outcome and must not be borrowed.
 * The silent first watch posts no declaration; it simply finds
 * none here.
 */
const DECLARATION_RE = /^次は(EMAの差|RSI|MACD)を見てる/;
const HIT_CONDITIONS: { prefix: string; name: string }[] = [
  { prefix: "EMA、", name: "EMAの差" },
  { prefix: "RSI、", name: "RSI" },
  { prefix: "MACD、", name: "MACD" },
];

export function declarationForHit(
  entries: NarrationEntry[],
  hitIndex: number,
): NarrationEntry | null {
  const hit = entries[hitIndex];
  if (!hit || hit.kind !== "watchHit") return null;
  const condition = HIT_CONDITIONS.find((c) =>
    hit.text.startsWith(c.prefix),
  );
  if (!condition) return null;
  for (let i = hitIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.kind === "watchHit" || e.kind === "nearMiss") return null;
    const m = DECLARATION_RE.exec(e.text);
    if (m && m[1] === condition.name) return e;
  }
  return null;
}

/**
 * The declaration behind a forecast verdict. Unlike the
 * watches, forecasts are not serial — declarations can be an
 * hour apart under a two-hour horizon, so two can be
 * outstanding at once and their claim texts may read alike.
 * The pairing is therefore by identity, not by text: the
 * declaration and verdict entries carry the forecast's origin
 * (see NarrationEntry.forecastOrigin), and the match is the
 * one earlier forecastCall with the same origin. Entries from
 * before the origin was recorded carry none and simply find
 * no declaration here. The scan stays inside one pair's entry
 * list, so a verdict can never borrow another pair's promise.
 */
export function declarationForVerdict(
  entries: NarrationEntry[],
  verdictIndex: number,
): NarrationEntry | null {
  const verdict = entries[verdictIndex];
  if (
    !verdict ||
    (verdict.kind !== "forecastHit" && verdict.kind !== "forecastMiss") ||
    verdict.forecastOrigin == null
  )
    return null;
  for (let i = verdictIndex - 1; i >= 0; i--) {
    const e = entries[i];
    if (
      e.kind === "forecastCall" &&
      e.forecastOrigin === verdict.forecastOrigin
    )
      return e;
  }
  return null;
}

/** Moments that appeared in `next` since `prevIds` was taken,
 * fresh enough to bookmark, oldest first. */
export function captureHighlights(
  prevIds: ReadonlySet<string>,
  next: NarrationState,
  now: number,
): Highlight[] {
  const out: Highlight[] = [];
  next.entries.forEach((entry, index) => {
    if (prevIds.has(entry.id) || !isHighlightEntry(entry)) return;
    if (Math.abs(now - entry.at) > HIGHLIGHT_FRESH_MS) return;
    const window = next.entries.slice(
      Math.max(0, index - (ENTRIES_AROUND - 1)),
      index + 1,
    );
    // A hit replay that opens mid-boast is unreadable — 田嶋
    // could not tell whether the moment had really hit. When
    // the declaration that promised it fell outside the window,
    // prepend it, so the replay starts with the promise.
    if (entry.kind === "watchHit") {
      const declaration = declarationForHit(next.entries, index);
      if (declaration && !window.some((e) => e.id === declaration.id))
        window.unshift(declaration);
    }
    // A verdict replay has the same need: the answer without
    // the claim that set it up is only half the story. When
    // the declaration fell outside the window, prepend it.
    if (entry.kind === "forecastHit" || entry.kind === "forecastMiss") {
      const declaration = declarationForVerdict(next.entries, index);
      if (declaration && !window.some((e) => e.id === declaration.id))
        window.unshift(declaration);
    }
    out.push({
      id: entry.id,
      at: entry.at,
      kind: entry.kind,
      ...(entry.side ? { side: entry.side } : {}),
      title: entry.text,
      entries: window.map(slim),
      prices: [...next.priceHistory],
    });
  });
  return out;
}

/** Append fresh highlights, deduped by id, newest kept, then
 * trimmed to the per-kind caps. Returns the same array
 * reference when nothing was added. */
export function appendHighlights(
  list: Highlight[],
  fresh: Highlight[],
): Highlight[] {
  const known = new Set(list.map((h) => h.id));
  const added = fresh.filter((h) => !known.has(h.id));
  if (!added.length) return list;
  return capHighlights([...list, ...added]);
}

const KEY = "suiba.highlights.v1";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
const entrySchema = z.object({
  id: z.string(),
  at: z.number().finite(),
  kind: z.string(),
  text: z.string(),
  side: z.enum(["BUY", "SELL"]).optional(),
});
const schema = z
  .array(
    z.object({
      id: z.string(),
      at: z.number().finite(),
      kind: z.string(),
      side: z.enum(["BUY", "SELL"]).optional(),
      title: z.string(),
      // +1: a watchHit or forecast-verdict highlight may carry
      // its prepended declaration on top of the usual window.
      entries: z.array(entrySchema).max(ENTRIES_AROUND + 1),
      prices: z.array(z.number().finite()).max(60),
    }),
  )
  .max(MAX_HIGHLIGHTS);

// Per pair, mirroring the narration scopes ("SUI" keeps the
// bare key, other pairs are suffixed).
function keyFor(scope: string): string {
  return scope === "SUI" ? KEY : `${KEY}:${scope}`;
}

export function loadHighlights(
  scope = "SUI",
  storage?: StorageAccess,
): Highlight[] {
  try {
    const raw = (storage ?? window.localStorage).getItem(keyFor(scope));
    if (!raw || raw.length > 500_000) return [];
    const result = schema.safeParse(JSON.parse(raw));
    // Lists stored before the per-kind caps may already be
    // flooded with one kind; trim on the way in so the strip
    // recovers without waiting for new moments.
    return result.success ? capHighlights(result.data as Highlight[]) : [];
  } catch {
    return [];
  }
}

export function saveHighlights(
  list: Highlight[],
  scope = "SUI",
  storage?: StorageAccess,
): void {
  try {
    (storage ?? window.localStorage).setItem(
      keyFor(scope),
      JSON.stringify(list),
    );
  } catch {
    // Storage trouble must not interrupt the live feed.
  }
}
