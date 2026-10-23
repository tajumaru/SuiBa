import type {
  BacktestEvent,
  ComparisonResult,
  CurvePoint,
  RunResult,
} from "../../../packages/backtest-engine/src/index.ts";
import type { Candle } from "../../../packages/shared/src/index.ts";
import type { Fill } from "../../../packages/paper-trading/src/index.ts";

export type ReplayMode = "on" | "off";

/** Playback speeds offered by the replay UI. 1x advances one candle per step. */
export const REPLAY_SPEEDS = [1, 4, 12, 30] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Milliseconds between candles at 1x. Faster speeds divide this interval. */
export const REPLAY_STEP_MS = 600;

export const replayIntervalMs = (speed: ReplaySpeed) =>
  Math.max(20, Math.round(REPLAY_STEP_MS / speed));

/**
 * Number of frames a replay can show. Candles, curve points and events are
 * produced one-per-bar by the backtest engine, so the shortest series is the
 * safe frame count if a stored result is ever inconsistent.
 */
export function replayLength(result: ComparisonResult, mode: ReplayMode) {
  const run = result[mode];
  return Math.min(result.candles.length, run.curve.length, run.events.length);
}

export function clampReplayIndex(
  result: ComparisonResult,
  mode: ReplayMode,
  index: number,
) {
  const total = replayLength(result, mode);
  if (total <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(total - 1, Math.max(0, Math.floor(index)));
}

export interface ReplayFrame {
  index: number;
  total: number;
  /** True when the cursor sits on the final candle. */
  isEnd: boolean;
  candle: Candle;
  curvePoint: CurvePoint;
  event: BacktestEvent;
  /** Equity (USDC) at this frame and its return versus the initial equity. */
  equity: number;
  returnPct: number;
  /** Drawdown at this frame, as a fraction (0.02 = 2%). */
  drawdown: number;
  /** Fills executed up to and including this frame, in order. */
  trades: Fill[];
  buyCount: number;
  sellCount: number;
  /** SUI currently held according to the fills so far. */
  holdingsSui: number;
  /** Realised profit (USDC) from SELL fills so far. */
  realizedPnl: number;
  /** Events up to this frame, newest first, capped for the live feed. */
  recentEvents: BacktestEvent[];
}

const realizedOf = (trade: Fill) =>
  Number(trade.realizedProfitUsdc ?? trade.pnl ?? 0) || 0;

/**
 * Pure snapshot of a backtest at one candle. The replay UI renders only this
 * frame, so scrubbing, stepping and playback all agree with each other and
 * with the comparison tables computed from the same result.
 */
export function replayFrame(
  result: ComparisonResult,
  mode: ReplayMode,
  index: number,
): ReplayFrame | null {
  const total = replayLength(result, mode);
  if (total <= 0) return null;
  const run: RunResult = result[mode];
  const i = clampReplayIndex(result, mode, index);
  const trades = run.events
    .slice(0, i + 1)
    .flatMap((e) => (e.trade ? [e.trade] : []));
  const curvePoint = run.curve[i];
  const initial = result.options.initialUsdc;
  return {
    index: i,
    total,
    isEnd: i === total - 1,
    candle: result.candles[i],
    curvePoint,
    event: run.events[i],
    equity: curvePoint.equity,
    returnPct: initial > 0 ? (curvePoint.equity / initial - 1) * 100 : 0,
    drawdown: curvePoint.drawdown,
    trades,
    buyCount: trades.filter((t) => t.side === "BUY").length,
    sellCount: trades.filter((t) => t.side === "SELL").length,
    holdingsSui: trades.reduce(
      (sum, t) => sum + (t.side === "BUY" ? t.quantity : -t.quantity),
      0,
    ),
    realizedPnl: trades
      .filter((t) => t.side === "SELL")
      .reduce((sum, t) => sum + realizedOf(t), 0),
    recentEvents: run.events
      .slice(0, i + 1)
      .slice(-5)
      .reverse(),
  };
}
