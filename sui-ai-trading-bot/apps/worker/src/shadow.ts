import { createHash } from "node:crypto";
import { z } from "zod";
import {
  dayKey,
  type Candle,
  type Portfolio,
  type Settings,
  type TradingDecision,
  type TradingPair,
} from "../../../packages/shared/src/index.ts";
import type { MarketStatus } from "../../../packages/market-data/src/provider.ts";
import type { BotDatabase } from "../../../packages/database/src/index.ts";

export const SHADOW_PROMPT_VERSION = "shadow-s1-v1";
const indicators = [
  "ema20",
  "ema50",
  "rsi",
  "macd",
  "signal",
  "histogram",
  "atr",
  "volumeChange",
  "priceChange",
] as const;
export const refKeys = {
  indicator: indicators,
  condition: [
    "emaUp",
    "rsiRecovery",
    "histogramImproving",
    "hasPosition",
    "stopLoss",
    "takeProfit",
    "latestVolumePositive",
    "previousVolumePositive",
    "volumeChangeExceeded",
    "emaGapShrinking",
    "emaDown",
    "rsiReversal",
    "histogramDeclining",
  ],
  candle: [
    "open",
    "high",
    "low",
    "close",
    "volume",
    "timestamp",
    "periodHigh",
    "periodLow",
    "changePct",
  ],
  book: ["bid", "ask", "spread", "fetchedAt"],
  portfolio: ["hasPosition", "entryPrice", "dailyBought"],
} as const;
const finite = z.number().finite();
const responseSchema = z
  .object({
    action: z.enum(["BUY", "WAIT"]),
    confidence: finite.min(0).max(1),
    rationale: z
      .object({
        refs: z
          .array(
            z
              .object({
                type: z.enum([
                  "indicator",
                  "condition",
                  "candle",
                  "book",
                  "portfolio",
                ]),
                key: z.string(),
                value: z.union([finite, z.boolean()]),
              })
              .strict(),
          )
          .max(5),
        text: z.string().refine((s) => Array.from(s).length <= 200),
      })
      .strict(),
    model: z.string().min(1).max(200),
    promptVersion: z.literal(SHADOW_PROMPT_VERSION),
    usage: z
      .object({
        inputTokens: finite.int().nonnegative(),
        outputTokens: finite.int().nonnegative(),
        cost: finite.nonnegative(),
      })
      .strict(),
  })
  .strict();
export interface ShadowInput {
  cycleId: string;
  pair: TradingPair;
  now: number;
  candles: Candle[];
  decision: TradingDecision;
  portfolio: Portfolio;
  settings: Settings;
  market: MarketStatus | null;
  healthy: boolean;
}
export function coreCount(d: TradingDecision) {
  return ["emaUp", "rsiRecovery", "histogramImproving"].filter(
    (k) => d.evidence?.conditions[k] === true,
  ).length;
}
/** Same close-seeded EMA50 and trailing 24h bands as run-review.py. */
export function shadowRegime(
  candles: Candle[],
): "up" | "down" | "range" | "unknown" {
  const end = candles.at(-1)?.timestamp;
  if (end === undefined) return "unknown";
  let value: number | undefined, prior: number | undefined;
  for (const c of candles) {
    value =
      value === undefined ? c.close : value + (2 / 51) * (c.close - value);
    if (c.timestamp <= end - 86400) prior = value;
  }
  if (prior === undefined || value === undefined || prior <= 0)
    return "unknown";
  const slope = (value / prior - 1) * 100;
  return slope >= 0.5 ? "up" : slope <= -0.5 ? "down" : "range";
}
export function freezeSnapshot(i: ShadowInput) {
  const e = i.decision.evidence!;
  const candles = i.candles.slice(-50);
  const snapshot = JSON.parse(
    JSON.stringify({
      cycleId: i.cycleId,
      pair: i.pair,
      evaluatedAt: e.evaluatedAt,
      candleTimestamp: e.candleTimestamp,
      candles,
      candle: {
        ...candles.at(-1),
        periodHigh: Math.max(...i.candles.map((c) => c.high)),
        periodLow: Math.min(...i.candles.map((c) => c.low)),
        changePct: (i.candles.at(-1)!.close / i.candles[0].open - 1) * 100,
      },
      evidence: e,
      conditionCount: coreCount(i.decision),
      ruleAction: i.decision.action,
      book: {
        bid: i.market?.bid ?? null,
        ask: i.market?.ask ?? null,
        spread: i.market?.spread ?? null,
        fetchedAt: i.market?.bookAt ?? null,
      },
      portfolio: {
        hasPosition: i.portfolio.sui > 0,
        entryPrice: e.inputs.entryPrice,
        dailyBought: i.portfolio.dailyBought,
      },
      settings: i.settings,
    }),
  ) as Snapshot;
  deepFreeze(snapshot);
  return {
    snapshot,
    snapshotSha256: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
  };
}
type Snapshot = {
  cycleId: string;
  pair: TradingPair;
  evaluatedAt: number;
  candleTimestamp: number;
  candles: Candle[];
  candle: Record<string, unknown>;
  evidence: NonNullable<TradingDecision["evidence"]>;
  conditionCount: number;
  ruleAction: string;
  book: Record<string, unknown>;
  portfolio: Record<string, unknown>;
  settings: Settings;
};
function deepFreeze(value: object) {
  Object.freeze(value);
  for (const v of Object.values(value))
    if (v && typeof v === "object") deepFreeze(v);
}
export function shadowPrompt(snapshot: Readonly<Snapshot>): string {
  return JSON.stringify({
    promptVersion: SHADOW_PROMPT_VERSION,
    instruction:
      "Return one JSON object only. Evaluate BUY or WAIT for the flat position using only this frozen snapshot. Never place orders or change settings. References must name an allowlisted field and its exact observed value. No invented or repaired values.",
    output: {
      action: ["BUY", "WAIT"],
      confidence: "number [0,1]",
      rationale: {
        refs: "at most 5 {type,key,value} entries",
        text: "at most 200 Unicode characters",
      },
      model: "response model id",
      promptVersion: SHADOW_PROMPT_VERSION,
      usage: {
        inputTokens: "nonnegative integer",
        outputTokens: "nonnegative integer",
        cost: "nonnegative number; provider adapter supplies metering",
      },
    },
    referenceKeys: refKeys,
    snapshot,
  });
}
export interface ShadowAdapter {
  /** No engine, database, network client or credentials in the request. */
  complete(request: {
    snapshot: Readonly<Snapshot>;
    prompt: string;
    promptVersion: typeof SHADOW_PROMPT_VERSION;
    signal: AbortSignal;
  }): Promise<unknown>;
}
export function validateShadowOutput(raw: unknown, s: Snapshot) {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw Error("INVALID_JSON");
    }
  }
  const result = responseSchema.safeParse(parsed);
  if (!result.success) throw Error("INVALID_SCHEMA");
  for (const ref of result.data.rationale.refs) {
    const keys: readonly string[] = refKeys[ref.type];
    const source =
      ref.type === "indicator"
        ? s.evidence.inputs.current
        : ref.type === "condition"
          ? s.evidence.conditions
          : s[ref.type];
    if (
      !keys.includes(ref.key) ||
      !Object.hasOwn(source, ref.key) ||
      (source as Record<string, unknown>)[ref.key] !== ref.value
    )
      throw Error("INVALID_REFERENCE");
  }
  return result.data;
}
/** Opt-in recorder. Provider selection is deliberately absent in S1.
 * offer() only freezes eligible inputs; invocation and all persistence run in
 * a later event-loop turn, outside the tick promise and analysis transaction. */
export type ShadowBudget = Pick<
  BotDatabase,
  "reserveShadowCall" | "shadowLastCall"
>;
const flights = new WeakMap<ShadowBudget, { busy: boolean; active: boolean }>();
export class ShadowRecorder {
  private flight: { busy: boolean; active: boolean };
  private previousCount: number | undefined;
  private previousRegime: string | undefined;
  constructor(
    private db: Pick<
      BotDatabase,
      "append" | "reserveShadowCall" | "shadowLastCall"
    >,
    private adapter?: ShadowAdapter,
    private enabled = () => process.env.SUIBA_SHADOW_ENABLED === "true",
    private budget: ShadowBudget = db,
  ) {
    const state = flights.get(budget) ?? { busy: false, active: false };
    flights.set(budget, state);
    this.flight = state;
  }
  offer(input: () => ShadowInput): void {
    try {
      if (
        !this.enabled() ||
        !this.adapter ||
        this.flight.busy ||
        this.flight.active
      )
        return;
      const i = input();
      if (
        !i.healthy ||
        i.portfolio.sui > 0 ||
        !i.decision.evidence ||
        i.candles.length === 0
      )
        return;
      const count = coreCount(i.decision),
        regime = shadowRegime(i.candles);
      const last = this.budget.shadowLastCall();
      const trigger =
        count === 2 ||
        (this.previousCount !== undefined && count > this.previousCount) ||
        i.decision.action === "BUY" ||
        (regime !== "unknown" &&
          this.previousRegime !== undefined &&
          this.previousRegime !== "unknown" &&
          regime !== this.previousRegime) ||
        last === null ||
        i.now - last >= 900000;
      this.previousCount = count;
      this.previousRegime = regime;
      if (!trigger || (last !== null && i.now - last < 300000)) return;
      const frozen = freezeSnapshot(i);
      const offeredAt = i.now;
      this.flight.busy = true;
      setImmediate(() => {
        void this.run(offeredAt, frozen).finally(() => {
          this.flight.busy = false;
        });
      });
    } catch {
      /* Shadow failures never reach trading or safety paths. */
    }
  }
  private async run(now: number, frozen: ReturnType<typeof freezeSnapshot>) {
    const { snapshot: s } = frozen;
    const base = {
      cycleId: s.cycleId,
      pair: s.pair,
      candleTimestamp: s.candleTimestamp,
      ...frozen,
      ruleAction: s.ruleAction,
      selectedRule: s.evidence.selectedRule,
      conditionCount: s.conditionCount,
      promptVersion: SHADOW_PROMPT_VERSION,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      if (!this.enabled()) return;
      if (!this.budget.reserveShadowCall(dayKey(now), now)) {
        this.db.append(
          "shadow_decisions",
          s.cycleId,
          { ...base, status: "SKIPPED_BUDGET" },
          now,
        );
        return;
      }
      const calledAt = Date.now(),
        began = performance.now();
      let record: Record<string, unknown>;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Error("TIMEOUT"));
          }, 30000);
        });
        this.flight.active = true;
        const invocation = Promise.resolve().then(() =>
          this.adapter!.complete({
            snapshot: s,
            prompt: shadowPrompt(s),
            promptVersion: SHADOW_PROMPT_VERSION,
            signal: controller.signal,
          }),
        );
        void invocation.then(
          () => {
            this.flight.active = false;
          },
          () => {
            this.flight.active = false;
          },
        );
        const raw = await Promise.race([invocation, timeout]);
        const output = validateShadowOutput(raw, s);
        // Known host credential is never persisted even if echoed by an adapter.
        const key = process.env.SUIBA_SHADOW_API_KEY;
        if (key && JSON.stringify(output).includes(key))
          throw Error("CREDENTIAL_IN_OUTPUT");
        record = {
          ...base,
          ...output,
          status: "OK",
          calledAt,
          latencyMs: performance.now() - began,
        };
      } catch (error) {
        const allowed = [
          "INVALID_JSON",
          "INVALID_SCHEMA",
          "INVALID_REFERENCE",
          "TIMEOUT",
          "CREDENTIAL_IN_OUTPUT",
        ];
        record = {
          ...base,
          status: "ERROR",
          reasonCode:
            error instanceof Error && allowed.includes(error.message)
              ? error.message
              : "ADAPTER_FAILED",
          calledAt,
          latencyMs: performance.now() - began,
        };
      }
      this.db.append("shadow_decisions", s.cycleId, record, now);
    } catch {
      /* Storage failure is isolated too; never log adapter errors/raw data. */
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
