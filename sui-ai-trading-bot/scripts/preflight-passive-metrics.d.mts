export interface PreflightPassiveMetricStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}
export interface PreflightPassiveMetricsRecord {
  event: "PREFLIGHT_PASSIVE_METRICS";
  scope: "CUMULATIVE";
  at: number;
  eventLoop: PreflightPassiveMetricStats;
  sqlite: Record<string, PreflightPassiveMetricStats & { failures: number }>;
  sqliteBusy: number;
  sqliteLocked: number;
}
export function installPreflightMetrics(
  prototype: object,
  emit: (record: PreflightPassiveMetricsRecord) => void,
): { sample(): void; stop(): void };
