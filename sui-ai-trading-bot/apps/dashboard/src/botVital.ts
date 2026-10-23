import type { OperationsSnapshot } from "./operationsTypes.ts";

/**
 * The bot's "vital signs": a heartbeat view of the operations snapshot.
 *
 * Precedence, highest first (mirrors `operationSummary` in
 * OperationOverview.tsx so the two displays can never contradict):
 *   1. stale display / expired evidence  -> unknown （状態確認中）
 *   2. safety stop (ABNORMAL / EMERGENCY) -> flatlined
 *   3. stopped                           -> sleeping
 *   4. recovering / degraded connectivity -> weak (only while not stopped)
 *   5. running on fresh evidence         -> alive
 * Connectivity never outranks the bot's own run state: a stopped bot must
 * not show a weak heartbeat just because the network is recovering.
 *
 * The animation is a visualisation of recorded evidence only. It never
 * invents activity the worker did not report, and its speed is a fixed
 * symbol of the state — not a measurement of fetch or analysis frequency.
 */
export type VitalState =
  | "alive" // 正常稼働: beating steadily
  | "weak" // 復旧確認中・通信障害: beating slowly
  | "sleeping" // 停止中: no beat
  | "flatlined" // 安全停止: no beat, flat ECG
  | "unknown"; // 状態不明・古い表示: no beat

/**
 * Freshness bounds, mirrored from the worker's existing monitoring limits
 * (`monitoringLimits` in apps/worker/src/operations.ts). The dashboard only
 * imports worker types, so the values are restated here with their source:
 * - heartbeat: the worker records a heartbeat every heartbeatMs (15s) and
 *   its snapshot accounts running time up to heartbeatMs * 2, so evidence
 *   older than 30s is no longer "latest".
 * - receipt: the operations panel polls every 10s, so a snapshot that has
 *   not been replaced for 30s (three cycles) is no longer latest either.
 * - fetch deadline: the worker itself treats a fetch running longer than
 *   fetchDeadlineMs (45s) as stalled, so it must not display as "取得中".
 */
export const VITAL_HEARTBEAT_FRESH_MS = 30_000;
export const VITAL_RECEIPT_FRESH_MS = 30_000;
export const VITAL_FETCH_DEADLINE_MS = 45_000;

export interface BotVital {
  state: VitalState;
  /** Short label shown next to the heart. */
  label: string;
  /** Heartbeat period in seconds, or null when the heart must not beat. */
  beatSeconds: number | null;
  /** ECG trace style for this state. */
  ecg: "flowing" | "slow" | "flat";
  /**
   * True only when the worker reports a fetch in progress that is still
   * within its deadline, the evidence is fresh, and the bot is not stopped.
   */
  fetching: boolean;
  /**
   * True when live-looking evidence (worker heartbeat and/or snapshot
   * receipt) is older than the freshness bounds and a beating state was
   * therefore downgraded to unknown. Callers pass this to
   * `operationSummary` as its stale flag so both displays agree.
   */
  evidenceStale: boolean;
  /** Whole seconds since the last successful strategy analysis. */
  lastAnalysisSecondsAgo: number | null;
  /** Whole seconds since the last successful market-data fetch. */
  lastFetchSecondsAgo: number | null;
  /** Whole seconds since the worker's own heartbeat was recorded. */
  heartbeatSecondsAgo: number | null;
  /** Whole seconds until the next scheduled fetch, when still ahead. */
  nextFetchSecondsIn: number | null;
  /** Whole seconds past the scheduled fetch time, when it has passed. */
  nextFetchOverdueSeconds: number | null;
}

const secondsAgo = (at: number | null | undefined, now: number) =>
  at == null ? null : Math.max(0, Math.floor((now - at) / 1000));

type VitalCore = Pick<
  BotVital,
  "state" | "label" | "beatSeconds" | "ecg" | "evidenceStale"
>;

export function botVital(
  d: OperationsSnapshot,
  stale = false,
  now = Date.now(),
  receivedAt?: number | null,
): BotVital {
  const s = d.safety;
  const heartbeatAgeMs =
    d.lastHeartbeatAt == null ? null : now - d.lastHeartbeatAt;
  const receiptAgeMs = receivedAt == null ? null : now - receivedAt;
  // Expired evidence only downgrades states that claim the bot is live
  // (alive / weak). Sleeping and flatlined make no liveness claim, and a
  // stopped bot's heartbeat record may legitimately age.
  const evidenceExpired =
    (heartbeatAgeMs != null && heartbeatAgeMs > VITAL_HEARTBEAT_FRESH_MS) ||
    (receiptAgeMs != null && receiptAgeMs > VITAL_RECEIPT_FRESH_MS);

  let core: VitalCore;
  if (stale) {
    core = {
      state: "unknown",
      label: "状態確認中",
      beatSeconds: null,
      ecg: "flat",
      evidenceStale: false,
    };
  } else if (
    d.status === "ABNORMAL_STOP" ||
    ["ABNORMAL_STOP", "EMERGENCY_STOP"].includes(s?.botState)
  ) {
    core = {
      state: "flatlined",
      label: "安全停止（鼓動なし）",
      beatSeconds: null,
      ecg: "flat",
      evidenceStale: false,
    };
  } else if (d.status === "STOPPED") {
    core = {
      state: "sleeping",
      label: "停止中（鼓動なし）",
      beatSeconds: null,
      ecg: "flat",
      evidenceStale: false,
    };
  } else if (s?.connectivity === "RECOVERING") {
    core = {
      state: "weak",
      label: "復旧確認中（弱い鼓動）",
      beatSeconds: 1.8,
      ecg: "slow",
      evidenceStale: false,
    };
  } else if (s?.connectivity === "DEGRADED" || d.status === "DATA_DELAYED") {
    core = {
      state: "weak",
      label: "通信が不安定（弱い鼓動）",
      beatSeconds: 1.8,
      ecg: "slow",
      evidenceStale: false,
    };
  } else if (
    d.status === "RUNNING" &&
    s?.ordersAllowed &&
    d.timing?.transportRecent &&
    ["FRESH", "UPDATING"].includes(d.timing.dataStatus)
  ) {
    core = {
      state: "alive",
      label: "鼓動中",
      beatSeconds: 1,
      ecg: "flowing",
      evidenceStale: false,
    };
  } else {
    core = {
      state: "unknown",
      label: "状態確認中",
      beatSeconds: null,
      ecg: "flat",
      evidenceStale: false,
    };
  }

  if (evidenceExpired && (core.state === "alive" || core.state === "weak")) {
    core = {
      state: "unknown",
      label: "状態確認中",
      beatSeconds: null,
      ecg: "flat",
      evidenceStale: true,
    };
  }

  const nextFetchAt = d.timing?.nextFetchAt ?? null;
  const fetchCredible =
    (d.timing?.fetching ?? false) &&
    d.timing?.fetchElapsedMs != null &&
    d.timing.fetchElapsedMs <= VITAL_FETCH_DEADLINE_MS;
  return {
    ...core,
    fetching:
      fetchCredible &&
      !core.evidenceStale &&
      (core.state === "alive" || core.state === "weak"),
    lastAnalysisSecondsAgo: secondsAgo(d.timing?.lastAnalysisAt, now),
    lastFetchSecondsAgo: secondsAgo(d.timing?.lastFetchSuccessAt, now),
    heartbeatSecondsAgo: secondsAgo(d.lastHeartbeatAt, now),
    nextFetchSecondsIn:
      nextFetchAt != null && nextFetchAt > now
        ? Math.ceil((nextFetchAt - now) / 1000)
        : null,
    nextFetchOverdueSeconds:
      nextFetchAt != null && nextFetchAt <= now
        ? Math.floor((now - nextFetchAt) / 1000)
        : null,
  };
}
