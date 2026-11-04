import type { BookLevels } from "../../../../packages/shared/src/index.ts";

/**
 * The order-book wall watch: the narration notices the book
 * only when something dramatic happens in it — a "wall" (one
 * level dwarfing the typical level) appears, vanishes without
 * trading, or is breached by the price. The book itself is
 * never drawn; only its events are told, in the same
 * ambience-only spirit as the BTC weather mutter. Everything
 * here is display-grade: the levels arrive beside the trading
 * paths and no decision ever reads this module.
 */

export interface BookWall {
  side: "bid" | "ask";
  price: number;
  /** Latest seen size at the level, in the base asset. */
  qty: number;
  /** How many times the side's median level size this wall
   * was when first detected. */
  multiple: number;
  sinceAt: number;
  /** Whether the appearance was told in the feed. Vanishing
   * and breaching are only told for announced walls — a wall
   * adopted silently (already there when the feed opened) or
   * swallowed by the rate limit leaves silently too. */
  announced: boolean;
}

export interface BookWallState {
  walls: BookWall[];
  /** The `at` of the last book snapshot processed, so a
   * re-rendered or frozen snapshot adds nothing. */
  bookAt: number | null;
  /** The first snapshot's walls are adopted silently, like
   * the price lines' silent takeover. */
  adopted: boolean;
  lastEntryAt: number | null;
  /** `${side}@${price}` → ms until which a re-appearance at
   * the same level stays silent (flicker guard). */
  cooldowns: Record<string, number>;
}

/** A level at least this many times the side's median level
 * size counts as a wall. */
export const WALL_MIN_MULTIPLE = 5;
/** Walls further than this from the mid are scenery, not
 * events. */
export const WALL_NEAR_PCT = 0.02;
/** A side needs at least this many levels before a median —
 * and therefore a wall — means anything. */
export const WALL_MIN_LEVELS = 4;
/** Appearances and vanishings keep this spacing between book
 * entries; a breach is a price event and may always speak. */
export const BOOK_ENTRY_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const BOOK_WALL_COOLDOWN_MS = 30 * 60 * 1000;

const wallKey = (side: "bid" | "ask", price: number) => `${side}@${price}`;

/** The walls standing in one book snapshot. */
export function detectBookWalls(book: BookLevels, now: number): BookWall[] {
  const bid0 = book.bids[0]?.[0],
    ask0 = book.asks[0]?.[0];
  if (!bid0 || !ask0 || !(ask0 > bid0)) return [];
  const mid = (bid0 + ask0) / 2;
  const walls: BookWall[] = [];
  for (const [side, levels] of [
    ["bid", book.bids],
    ["ask", book.asks],
  ] as const) {
    if (levels.length < WALL_MIN_LEVELS) continue;
    const qtys = levels
      .map((l) => l[1])
      .filter((q) => Number.isFinite(q) && q > 0)
      .sort((a, b) => a - b);
    if (qtys.length < WALL_MIN_LEVELS) continue;
    const median = qtys[Math.floor(qtys.length / 2)];
    if (!(median > 0)) continue;
    for (const [price, qty] of levels) {
      if (!Number.isFinite(price) || !Number.isFinite(qty)) continue;
      if (Math.abs(price / mid - 1) > WALL_NEAR_PCT) continue;
      const multiple = qty / median;
      if (multiple >= WALL_MIN_MULTIPLE)
        walls.push({ side, price, qty, multiple, sinceAt: now, announced: false });
    }
  }
  return walls;
}

const priceText = (v: number) =>
  `$${v >= 100 ? v.toFixed(2) : v.toFixed(4)}`;
const qtyText = (v: number) => Math.round(v).toLocaleString("en-US");
const sideName = (side: "bid" | "ask") => (side === "bid" ? "買い壁" : "売り壁");

export function advanceBookWalls(
  prev: BookWallState,
  book: BookLevels | null,
  base: string,
  now: number,
): { state: BookWallState; texts: string[] } {
  if (!book || book.at === prev.bookAt) return { state: prev, texts: [] };
  const detected = detectBookWalls(book, now);
  if (!prev.adopted) {
    // Silent takeover: the walls already standing when the
    // feed opened are tracked, never announced.
    return {
      state: { ...prev, walls: detected, bookAt: book.at, adopted: true },
      texts: [],
    };
  }
  const texts: string[] = [];
  let lastEntryAt = prev.lastEntryAt;
  const cooldowns = { ...prev.cooldowns };
  const detectedByKey = new Map(
    detected.map((w) => [wallKey(w.side, w.price), w]),
  );
  const nextWalls: BookWall[] = [];
  const goneCandidates: BookWall[] = [];
  // Standing walls: refresh, breach, or vanish.
  for (const wall of prev.walls) {
    const still = detectedByKey.get(wallKey(wall.side, wall.price));
    if (still) {
      nextWalls.push({ ...wall, qty: still.qty });
      detectedByKey.delete(wallKey(wall.side, wall.price));
      continue;
    }
    const breached =
      wall.side === "ask"
        ? (book.bids[0]?.[0] ?? -Infinity) >= wall.price
        : (book.asks[0]?.[0] ?? Infinity) <= wall.price;
    if (wall.announced && breached) {
      texts.push(
        `${sideName(wall.side)} ${priceText(wall.price)} を${wall.side === "ask" ? "上に" : "下に"}抜けた`,
      );
      lastEntryAt = now;
      cooldowns[wallKey(wall.side, wall.price)] = now + BOOK_WALL_COOLDOWN_MS;
    } else if (wall.announced) {
      goneCandidates.push(wall);
      cooldowns[wallKey(wall.side, wall.price)] = now + BOOK_WALL_COOLDOWN_MS;
    }
  }
  // New walls.
  const appearedCandidates: BookWall[] = [];
  for (const wall of detectedByKey.values()) {
    const until = cooldowns[wallKey(wall.side, wall.price)] ?? 0;
    if (until > now) {
      nextWalls.push(wall); // flicker guard: tracked, unannounced
      continue;
    }
    appearedCandidates.push(wall);
  }
  const speak = () =>
    lastEntryAt == null || now - lastEntryAt >= BOOK_ENTRY_MIN_INTERVAL_MS;
  appearedCandidates.sort((a, b) => b.qty * b.price - a.qty * a.price);
  for (const wall of appearedCandidates) {
    if (speak()) {
      texts.push(
        `${priceText(wall.price)} に${sideName(wall.side)} ${qtyText(wall.qty)} ${base}（ふだんの段の約${Math.round(wall.multiple)}倍）`,
      );
      lastEntryAt = now;
      nextWalls.push({ ...wall, announced: true });
    } else {
      nextWalls.push(wall);
    }
  }
  goneCandidates.sort((a, b) => b.qty * b.price - a.qty * a.price);
  for (const wall of goneCandidates) {
    if (speak()) {
      texts.push(
        `${priceText(wall.price)} の${sideName(wall.side)}、消えた（約定せずに引っ込んだ）`,
      );
      lastEntryAt = now;
    }
    break; // at most one vanishing per snapshot is told
  }
  return {
    state: { walls: nextWalls, bookAt: book.at, adopted: true, lastEntryAt, cooldowns },
    texts,
  };
}
