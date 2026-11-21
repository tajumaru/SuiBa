import type { BotDatabase } from "../../../packages/database/src/index.ts";
import { equity } from "../../../packages/portfolio/src/index.ts";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";
import type { BossBattleState } from "../../../packages/shared/src/boss.ts";
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

type StoredBattle = BossBattleState & { openingCandleAt: number };

const key = (pair: TradingPair) => `boss:${pair}`;

export function readBoss(
  db: BotDatabase,
  pair: TradingPair,
): BossBattleState | null {
  const stored = db.get<StoredBattle>(key(pair));
  if (!stored) return null;
  const { openingCandleAt: _openingCandleAt, ...battle } = stored;
  return battle;
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
  const fast = db.candles(300);
  const current = fast.at(-1);
  if (
    !current ||
    current.close <= 0 ||
    db.get<number>("price") !== current.close
  )
    return;

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
  const previous = db.get<StoredBattle>(key(pair));
  const active = previous && !previous.outcome ? previous : null;
  if (!active && !triggered) return;

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
  db.set(key(pair), boss);
}
