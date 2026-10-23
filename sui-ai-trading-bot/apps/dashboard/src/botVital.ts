import type { OperationsSnapshot } from "./operationsTypes.ts";

/**
 * The bot's "vital signs": a heartbeat view of the operations snapshot.
 *
 * The state mapping intentionally mirrors `operationSummary` in
 * OperationOverview.tsx (same evidence, same order of checks) so the
 * animation can never claim the bot is alive when the summary says it is
 * stopped. The animation is a visualisation of recorded evidence only:
 * it never invents activity the worker did not report.
 */
export type VitalState =
  | "alive" // 正常稼働: beating steadily
  | "weak" // 復旧確認中・通信障害: beating slowly
  | "sleeping" // 停止中: no beat
  | "flatlined" // 安全停止: no beat, flat ECG
  | "unknown"; // 状態不明・古い表示: no beat

export interface BotVital {
  state: VitalState;
  /** Short label shown next to the heart. */
  label: string;
  /** Heartbeat period in seconds, or null when the heart must not beat. */
  beatSeconds: number | null;
  /** ECG trace style for this state. */
  ecg: "flowing" | "slow" | "flat";
  /** True while the worker is fetching market data right now. */
  fetching: boolean;
  /** Whole seconds since the last successful strategy analysis. */
  lastAnalysisSecondsAgo: number | null;
  /** Whole seconds since the last successful market-data fetch. */
  lastFetchSecondsAgo: number | null;
  /** Whole seconds since the worker's own heartbeat was recorded. */
  heartbeatSecondsAgo: number | null;
  /** Whole seconds until the next scheduled fetch, when known. */
  nextFetchSecondsIn: number | null;
}

const secondsAgo = (at: number | null | undefined, now: number) =>
  at == null ? null : Math.max(0, Math.floor((now - at) / 1000));
const secondsIn = (at: number | null | undefined, now: number) =>
  at == null ? null : Math.max(0, Math.ceil((at - now) / 1000));

export function botVital(
  d: OperationsSnapshot,
  stale = false,
  now = Date.now(),
): BotVital {
  const s = d.safety;
  const activity = {
    fetching: d.timing?.fetching ?? false,
    lastAnalysisSecondsAgo: secondsAgo(d.timing?.lastAnalysisAt, now),
    lastFetchSecondsAgo: secondsAgo(d.timing?.lastFetchSuccessAt, now),
    heartbeatSecondsAgo: secondsAgo(d.lastHeartbeatAt, now),
    nextFetchSecondsIn: secondsIn(d.timing?.nextFetchAt, now),
  };
  if (stale)
    return {
      state: "unknown",
      label: "状態確認中",
      beatSeconds: null,
      ecg: "flat",
      ...activity,
    };
  if (
    d.status === "ABNORMAL_STOP" ||
    ["ABNORMAL_STOP", "EMERGENCY_STOP"].includes(s?.botState)
  )
    return {
      state: "flatlined",
      label: "安全停止（鼓動なし）",
      beatSeconds: null,
      ecg: "flat",
      ...activity,
    };
  if (s?.connectivity === "RECOVERING")
    return {
      state: "weak",
      label: "復旧確認中（弱い鼓動）",
      beatSeconds: 1.8,
      ecg: "slow",
      ...activity,
    };
  if (s?.connectivity === "DEGRADED" || d.status === "DATA_DELAYED")
    return {
      state: "weak",
      label: "通信が不安定（弱い鼓動）",
      beatSeconds: 1.8,
      ecg: "slow",
      ...activity,
    };
  if (d.status === "STOPPED")
    return {
      state: "sleeping",
      label: "停止中（鼓動なし）",
      beatSeconds: null,
      ecg: "flat",
      ...activity,
    };
  if (
    d.status === "RUNNING" &&
    s?.ordersAllowed &&
    d.timing?.transportRecent &&
    ["FRESH", "UPDATING"].includes(d.timing.dataStatus)
  )
    return {
      state: "alive",
      label: "鼓動中",
      beatSeconds: 1,
      ecg: "flowing",
      ...activity,
    };
  return {
    state: "unknown",
    label: "状態確認中",
    beatSeconds: null,
    ecg: "flat",
    ...activity,
  };
}
