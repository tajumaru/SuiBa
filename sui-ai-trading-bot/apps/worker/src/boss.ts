import type { BotDatabase } from "../../../packages/database/src/index.ts";
import { equity } from "../../../packages/portfolio/src/index.ts";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import {
  bossPartyMembers,
  type BossBattleState,
  type BossHistoryRecord,
  type BossPartyActions,
} from "../../../packages/shared/src/boss.ts";
import type {
  Candle,
  Indicators,
  TradingPair,
} from "../../../packages/shared/src/index.ts";
import type { OperationEvent } from "../../../packages/shared/src/operations.ts";

const HOUR = 3600;
const DAY = 24 * HOUR;
const FLASH_DROP = 0.03;
const SWAMP_DROP = 0.05;
// Allow for round-off at inclusive decimal percentage boundaries.
const atLeast = (value: number, threshold: number) =>
  value + Number.EPSILON >= threshold;

type StoredBattle = BossBattleState & {
  openingCandleAt: number;
  partyBaseline?: BossPartyActions;
};

const key = (pair: TradingPair) => `boss:${pair}`;
const historyKey = (pair: TradingPair) => `bossHistory:${pair}`;
const HISTORY_LIMIT = 20;

export function readBossHistory(
  db: BotDatabase,
  pair: TradingPair,
): BossHistoryRecord[] {
  return db.get<BossHistoryRecord[]>(historyKey(pair)) ?? [];
}

export function readBoss(
  db: BotDatabase,
  pair: TradingPair,
): BossBattleState | null {
  const stored = db.get<StoredBattle>(key(pair));
  if (!stored) return null;
  const { openingCandleAt: _openingCandleAt, partyBaseline: _partyBaseline, ...battle } = stored;
  return battle;
}

function countPartyActions(db: BotDatabase, baseline?: BossPartyActions) {
  const counts = new Map(db.partyRecords().map(({ member, count }) => [member, count]));
  const partyBaseline: BossPartyActions = {};
  const partyActions: BossPartyActions = {};
  for (const member of bossPartyMembers) {
    const current = counts.get(member) ?? 0;
    const start = baseline?.[member] ?? current;
    partyBaseline[member] = start;
    partyActions[member] = Math.max(0, current - start);
  }
  return { partyBaseline, partyActions };
}

const closeAt = (candle: Candle) => candle.timestamp + candle.timeframe;

function windowReference(rows: Candle[], target: number, tolerance: number) {
  return rows.reduce<Candle | undefined>((ref, row) => {
    const at = closeAt(row);
    if (at > target || target - at >= Math.min(tolerance, row.timeframe))
      return ref;
    if (
      !ref ||
      at > closeAt(ref) ||
      (at === closeAt(ref) && row.timeframe < ref.timeframe)
    )
      return row;
    return ref;
  }, undefined);
}

function battleEvents(db: BotDatabase, from: number, now: number) {
  const fills = db.range<Fill>("paper_trades", from, now);
  const stops = db
    .range<OperationEvent>("operation_events", from, now)
    .filter(
      (event) =>
        event.kind === "STOP" &&
        !["MANUAL_STOP", "PROCESS_SHUTDOWN", "EMERGENCY_CLEARED"].includes(
          event.code,
        ),
    );
  const loss = fills.some(
    (fill) => fill.side === "SELL" && fill.pnl != null && fill.pnl < 0,
  );
  const stop = stops.at(-1);
  const fill = fills.at(-1);
  const latest =
    stop && (!fill || stop.timestamp >= fill.timestamp)
      ? stop.code === "EMERGENCY_STOP"
        ? "緊急停止が発生した。"
        : "安全停止が発生した。"
      : fill?.side === "BUY"
        ? "買いが約定した。"
        : fill
          ? fill.pnl != null && fill.pnl < 0
            ? "損失で手放した。"
            : "売りが約定した。"
          : null;
  const retreatReason =
    stop?.code === "EMERGENCY_STOP"
      ? "emergency"
      : stop
        ? "safety"
        : loss
          ? "loss"
          : null;
  return { latest, retreatReason } as const;
}

export function refreshBoss(
  db: BotDatabase,
  pair: TradingPair,
  now = Date.now(),
) {
  const previous = db.get<StoredBattle>(key(pair));
  const active = previous && !previous.outcome ? previous : null;
  const fast = db.candles(300);
  const current = fast.at(-1);
  if (
    !current ||
    current.close <= 0 ||
    db.get<number>("price") !== current.close
  ) {
    if (active) db.set(key(pair), { ...active, ...countPartyActions(db, active.partyBaseline) });
    return;
  }

  const recent = [fast, db.candles(900), db.candles(3600)]
    .flat()
    .filter(
      (row) =>
        row.source === current.source &&
        closeAt(row) <= closeAt(current) &&
        closeAt(row) > closeAt(current) - DAY - HOUR &&
        Number.isFinite(row.close) &&
        row.close > 0,
    );
  const dayStart = closeAt(current) - DAY;
  const oldest = recent.reduce<Candle | undefined>((first, row) => {
    if (closeAt(row) < dayStart) return first;
    if (
      !first ||
      closeAt(row) < closeAt(first) ||
      (closeAt(row) === closeAt(first) && row.timeframe < first.timeframe)
    )
      return row;
    return first;
  }, undefined);
  const hourRef = windowReference(
    recent,
    closeAt(current) - HOUR,
    current.timeframe,
  );
  const dayRef = windowReference(recent, dayStart, HOUR) ?? oldest;
  const drop = (ref: Candle | undefined) =>
    ref ? (ref.close - current.close) / ref.close : 0;
  const hourDrop = drop(hourRef);
  const dayDrop = drop(dayRef);
  const lightning = atLeast(hourDrop, FLASH_DROP);
  const triggered = lightning || atLeast(dayDrop, SWAMP_DROP);
  if (!active && !triggered) return;

  const party = countPartyActions(db, active?.partyBaseline);
  const rsi = db.get<Indicators>("indicators")?.rsi;
  const turn =
    rsi == null || !Number.isFinite(rsi)
      ? null
      : rsi < db.settings().oversold
        ? "boss"
        : "hero";
  let boss: StoredBattle;
  if (active) {
    const low = Math.min(
      active.low,
      current.close,
      ...fast
        .filter(
          (row) =>
            row.timestamp > active.openingCandleAt &&
            Number.isFinite(row.low) &&
            row.low > 0,
        )
        .map((row) => row.low),
    );
    const recovery =
      active.high > low
        ? Math.max(0, Math.min(1, (current.close - low) / (active.high - low)))
        : 0;
    const events = battleEvents(db, active.startedAt, now);
    const retreatReason = events.retreatReason ?? active.retreatReason;
    boss = {
      ...active,
      ...party,
      low,
      recovery,
      turn,
      retreatReason,
      latestEvent: events.latest ?? active.latestEvent,
      outcome: triggered
        ? null
        : { at: now, result: retreatReason ? "retreated" : "endured" },
    };
  } else {
    const triggerDrop = lightning ? hourDrop : dayDrop;
    const threshold = lightning ? FLASH_DROP : SWAMP_DROP;
    const strength = atLeast(triggerDrop, threshold * 2)
      ? "真"
      : atLeast(triggerDrop, threshold * 1.5)
        ? "大"
        : "通常";
    const base = lightning ? "閃光の投げ売り" : "底なしの沼";
    boss = {
      ...party,
      startedAt: now,
      openingCandleAt: current.timestamp,
      type: lightning ? "lightning" : "swamp",
      name: strength === "通常" ? base : `${strength}・${base}`,
      strength,
      drop: triggerDrop,
      windowSeconds:
        closeAt(current) - closeAt((lightning ? hourRef : dayRef)!),
      high: Math.max(
        current.close,
        ...recent
          .filter((row) => row.timestamp >= dayStart - current.timeframe)
          .map((row) => (Number.isFinite(row.high) ? row.high : row.close)),
      ),
      low: current.close,
      startingEquity: equity(db.portfolio(), current.close),
      recovery: 0,
      turn,
      latestEvent: null,
      retreatReason: null,
      outcome: null,
    };
  }
  const outcome = boss.outcome;
  if (!outcome) {
    db.set(key(pair), boss);
    return;
  }

  db.transaction(() => {
    // Recheck the transition under the write lock before recording it.
    const stored = db.get<StoredBattle>(key(pair));
    if (
      !stored ||
      stored.outcome ||
      stored.startedAt !== boss.startedAt ||
      stored.openingCandleAt !== boss.openingCandleAt
    )
      return;

    const { startedAt, type, name, strength, drop, recovery } = boss;
    const record: BossHistoryRecord = {
      startedAt,
      endedAt: outcome.at,
      type,
      name,
      strength,
      result: outcome.result,
      drop,
      recovery,
      partyActions: boss.partyActions,
    };
    db.set(historyKey(pair), [
      record,
      ...readBossHistory(db, pair).slice(0, HISTORY_LIMIT - 1),
    ]);
    db.set(key(pair), boss);
  });
}
