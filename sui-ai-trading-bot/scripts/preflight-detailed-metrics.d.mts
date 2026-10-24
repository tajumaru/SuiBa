export interface BufferedJsonlWriterOptions {
  flushIntervalMs?: number;
  flushBatchRecords?: number;
  maxRecords?: number;
  maxBytes?: number;
}
export interface BufferedJsonlWriterStats {
  file: string;
  written: number;
  dropped: number;
  bytesWritten: number;
  flushCount: number;
  flushFailures: number;
  flushTotalMs: number;
  flushMaxMs: number;
  truncated: boolean;
  queued: number;
}
export interface BufferedJsonlWriter {
  onFlush:
    | ((info: {
        file: string;
        records: number;
        bytes: number;
        startedAt: number;
        endedAt: number;
        durationMs: number;
        ok: boolean;
      }) => void)
    | null;
  push(record: unknown): boolean;
  flush(): void;
  stats(): BufferedJsonlWriterStats;
  stop(): BufferedJsonlWriterStats;
}
export interface DetailedMetricsInstallOptions {
  databaseClass: unknown;
  sqliteWriter: BufferedJsonlWriter;
  spikeWriter: BufferedJsonlWriter;
  eventLoopThresholdMs?: number;
  eventLoopWindowMs?: number;
}
export interface DetailedMetricsStatus {
  enabled: boolean;
  startedAt: number;
  endedAt: number;
  eventLoopThresholdMs: number;
  spikesDetected: number;
  sinkErrors: number;
  eventLoopCumulative: {
    count: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    maxMs: number | null;
  };
  sqliteWriter: BufferedJsonlWriterStats;
  spikeWriter: BufferedJsonlWriterStats;
}
export declare function createBufferedJsonlWriter(
  path: string,
  options?: BufferedJsonlWriterOptions,
): BufferedJsonlWriter;
export declare function installDetailedMetrics(
  options: DetailedMetricsInstallOptions,
): { stop(): DetailedMetricsStatus };
