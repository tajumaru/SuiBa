import { z } from "zod";
import {
  emptyNarrationState,
  MAX_NARRATION_ENTRIES,
  type NarrationState,
} from "./agentNarration.ts";

const KEY = "suiba.narration.v1";
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
const number = z.number().finite();
const nullableNumber = number.nullable();
const condition = z.enum(["emaUp", "rsiRecovery", "histogramImproving"]);
const trail = z.object({
  evaluatedAt: number,
  price: number,
  ema20: number,
  ema50: number,
  rsi: number,
  histogram: number,
  atr: number,
  oversold: number,
  emaUp: z.boolean(),
  emaGapShrinking: z.boolean(),
  rsiRecovery: z.boolean(),
  histogramImproving: z.boolean(),
  hasPosition: z.boolean(),
  rsiLinePrice: nullableNumber,
});
const schema: z.ZodType<NarrationState> = z.object({
  entries: z
    .array(
      z.object({
        id: z.string(),
        at: number,
        kind: z.enum([
          "cycle",
          "trade",
          "rejection",
          "stop",
          "start",
          "warning",
          "recovery",
          "nearMiss",
          "watchHit",
          "priceLine",
          "priceLineReached",
          "sellLine",
          "review",
          "alert",
          "sleepTalk",
          "chatUser",
          "chatReply",
          "status",
        ]),
        text: z.string(),
        side: z.enum(["BUY", "SELL"]).optional(),
      }),
    )
    .max(MAX_NARRATION_ENTRIES),
  nextEntryId: number.int().nonnegative(),
  priceRising: z.boolean(),
  priceHistory: z.array(number),
  alertCooldown: number,
  lastAlert: z
    .object({ at: number, direction: z.enum(["up", "down", "volume"]) })
    .nullable(),
  lastHitAt: nullableNumber,
  lastNearMiss: z
    .object({ key: condition, closestDistance: number })
    .nullable(),
  sleepingSince: nullableNumber,
  lastSleepTalkAt: nullableNumber,
  lastSleepTalkText: z.string().nullable(),
  watch: z
    .object({
      key: condition,
      declaredDistance: number,
      called: z.boolean(),
      closestDistance: number,
    })
    .nullable(),
  priceLine: z
    .object({ price: number, reached: z.boolean(), murmured: z.boolean() })
    .nullable(),
  // Stored states from before the sell lines existed parse with
  // the default instead of being thrown away.
  sellLines: z
    .object({ tp: number, sl: number })
    .nullable()
    .default(null),
  watchScore: z.object({
    declared: number,
    hits: number,
    misses: number,
    unreviewed: number,
  }),
  sessionStartPrice: nullableNumber,
  seen: z.array(z.string()).max(200),
  retiredEventThrough: nullableNumber,
  retiredCandidateThrough: nullableNumber,
  pendingCandidateIds: z.array(z.string()).max(50),
  lastDecisionAt: nullableNumber,
  prevDecisionPrice: nullableNumber,
  lastTrail: trail.nullable(),
  prevTrail: trail.nullable(),
  lastConnectivity: z.string().nullable(),
  lastStatus: z.string().nullable(),
  initialized: z.boolean(),
});

// Resolve storage inside the try: browsers may deny even the localStorage getter.
export function restoreNarration(storage?: StorageAccess): NarrationState {
  try {
    const raw = (storage ?? window.localStorage).getItem(KEY);
    if (!raw || raw.length > 500_000) return emptyNarrationState();
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : emptyNarrationState();
  } catch {
    return emptyNarrationState();
  }
}

export function persistNarration(
  state: NarrationState,
  storage?: StorageAccess,
): void {
  try {
    (storage ?? window.localStorage).setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage restrictions or a full quota must not interrupt live narration.
  }
}
