import { createHash } from "node:crypto";
import type { BotDatabase } from "../../../packages/database/src/index.ts";
import type { TradingPair } from "../../../packages/shared/src/index.ts";
import {
  advanceNarration,
  candidateKey,
  eventKey,
} from "../../dashboard/src/narration/advance.ts";
import {
  emptyNarrationState,
  type NarrationKind,
  type NarrationState,
} from "../../dashboard/src/narration/state.ts";
import type { BotEngine } from "./engine.ts";
import type { SituationMemory } from "./situation-memory.ts";
import { presetName } from "../../dashboard/src/settingsPresets.ts";

export const SERVER_NARRATION_KINDS = [
  "cycle", "trade", "rejection", "stop", "start", "warning", "recovery",
  "epoch", "btc", "forecastCall", "forecastHit", "forecastMiss",
  "forecastTouch", "forecastTouchNear", "bookWall", "forecastCalib", "memory",
] as const satisfies readonly NarrationKind[];
const serverKinds = new Set<NarrationKind>(SERVER_NARRATION_KINDS);
export const NARRATION_STATE_VERSION = 1;

type StoredState = {
  narration: NarrationState;
  lastEpoch: number | null;
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

export function narrationIdentity(
  pair: TradingPair,
  kind: NarrationKind,
  sourceKey: string,
  ordinal: number,
) {
  return createHash("sha256")
    .update(canonical(["narration", 1, pair, kind, sourceKey, ordinal]))
    .digest("hex");
}

function initialStoredState(): StoredState {
  return {
    // Server generation starts from persisted facts, not from the browser's
    // initial-status supplement. Marking it initialized makes stageEvents the
    // sole source of stop/start lines.
    narration: { ...emptyNarrationState(), initialized: true },
    lastEpoch: null,
  };
}

export class NarrationGenerator {
  constructor(
    private db: BotDatabase,
    private pair: TradingPair,
    private engine: BotEngine,
    private now: () => number = Date.now,
  ) {}

  enabled() {
    return process.env.SUIBA_NARRATION_GENERATION_ENABLED === "true";
  }

  generate() {
    if (!this.enabled()) return 0;
    const saved = this.db.narrationState(this.pair);
    if (saved && saved.version !== NARRATION_STATE_VERSION)
      throw new Error("NARRATION_STATE_VERSION_UNSUPPORTED");
    const stored = saved ? (saved.json as StoredState) : initialStoredState();
    if (!stored?.narration || !("lastEpoch" in stored))
      throw new Error("NARRATION_STATE_INVALID");

    const at = this.now();
    const before = stored.narration;
    const snapshot = this.engine.snapshot();
    const operations = {
      ...this.engine.monitor.snapshot(),
      situationMemory: this.db.get<SituationMemory>("situation_memory") ?? null,
    };
    const forecast = snapshot.forecast;
    let next = advanceNarration(
      before,
      operations,
      snapshot.runtime.running ? "alive" : snapshot.runtime.error ? "flatlined" : "sleeping",
      at,
      snapshot.trades,
      snapshot.btc,
      { records: forecast.records, candles: snapshot.candlesByTimeframe[300] },
      snapshot.bookLevels,
      this.pair.split("_")[0],
      forecast.events,
      "white",
      presetName(snapshot.settings) === "hard",
    );

    const priorIds = new Set(before.entries.map((entry) => entry.id));
    const candidates = next.entries.filter(
      (entry) => !priorIds.has(entry.id) && serverKinds.has(entry.kind),
    );
    const epoch = snapshot.chain?.epoch;
    if (Number.isSafeInteger(epoch) && epoch! >= 0 && stored.lastEpoch != null && epoch! > stored.lastEpoch) {
      candidates.push({
        id: `server-epoch:${epoch}`,
        at,
        kind: "epoch",
        text: `エポック ${epoch} が始まった（Suiチェーンの節目）`,
      });
    }

    // Device-only and stage-2 kinds must not consume the persisted server
    // feed. They may still update generator state needed by shared templates.
    next = { ...next, entries: next.entries.filter((entry) => serverKinds.has(entry.kind)) };
    const ordinals = new Map<string, number>();
    const rows = candidates.map((entry) => {
      const event = operations.events.find((item) => item.timestamp === entry.at);
      const candidate = operations.candidates.find((item) => item.timestamp === entry.at);
      const sourceFact = entry.kind === "cycle" && operations.decision
        ? `decision:${operations.decision.evaluatedAt}:${operations.decision.candleTimestamp}`
        : ["trade", "rejection", "stop"].includes(entry.kind) && candidate
          ? candidateKey(candidate)
          : ["stop", "start", "warning", "recovery"].includes(entry.kind) && event
            ? eventKey(event)
            : entry.forecastOrigin != null
              ? `forecast:${entry.forecastOrigin}`
              : entry.kind === "forecastCalib" && !entry.id.startsWith("narration:")
                ? `calibration:${entry.id}`
                : entry.kind === "btc" && snapshot.btc
                  ? `btc:${snapshot.btc.at}`
                  : entry.kind === "bookWall" && snapshot.bookLevels
                    ? `book:${snapshot.bookLevels.at}`
                    : entry.kind === "memory" && operations.situationMemory
                      ? `memory:${operations.situationMemory.key}:${operations.situationMemory.evaluatedAt}`
                      : entry.kind === "epoch" && epoch != null
                        ? `epoch:${epoch}`
                        : `${entry.kind}:${entry.at}`;
      const sourceBase = `${sourceFact}:${entry.kind}`;
      const ordinal = ordinals.get(sourceBase) ?? 0;
      ordinals.set(sourceBase, ordinal + 1);
      const sourceKey = `${sourceBase}:${ordinal}`;
      return {
        id: narrationIdentity(this.pair, entry.kind, sourceBase, ordinal),
        pair: this.pair,
        sourceKey,
        kind: entry.kind,
        occurredAt: entry.at,
        createdAt: at,
        json: {
          text: entry.text,
          ...(entry.side ? { side: entry.side } : {}),
          ...(entry.forecastOrigin == null ? {} : { forecastOrigin: entry.forecastOrigin }),
          ...(entry.sellLineSide ? { sellLineSide: entry.sellLineSide } : {}),
        },
      };
    });
    const lastEpoch = Number.isSafeInteger(epoch) && epoch! >= 0 ? epoch! : stored.lastEpoch;
    this.db.commitNarration(rows, {
      pair: this.pair,
      version: NARRATION_STATE_VERSION,
      updatedAt: at,
      json: { narration: next, lastEpoch } satisfies StoredState,
    });
    return rows.length;
  }
}
