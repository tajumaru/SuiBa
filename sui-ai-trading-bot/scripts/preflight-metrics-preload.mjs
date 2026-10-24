import "./enforce-node-version.mjs";
import { join } from "node:path";
import { BotDatabase } from "../packages/database/src/index.ts";
import { installPreflightMetrics } from "./preflight-passive-metrics.mjs";
import {
  createBufferedJsonlWriter,
  installDetailedMetrics,
} from "./preflight-detailed-metrics.mjs";
const metrics = installPreflightMetrics(BotDatabase.prototype, (record) => {
  // Docker captures stdout. Refuse backpressure instead of queuing unbounded evidence.
  if (!process.stdout.write(JSON.stringify(record) + "\n"))
    throw Error("VALIDATION_RECORD_FAILED");
});
// Detailed performance metrics are OFF unless explicitly enabled with
// SUIBA_PERF_DETAIL=1 (the Windows verification tool sets it, and can
// turn it back off with its -SkipPerfDetail switch). Enabling adds no
// RPC and no database writes; records are buffered JSONL files in the
// validation report directory.
let detailed = null;
if (process.env.SUIBA_PERF_DETAIL === "1") {
  const dir =
    process.env.SUIBA_PERF_DETAIL_DIR ??
    process.env.VALIDATION_REPORT_DIR ??
    "/app/reports";
  const parsedThreshold = Number(
    process.env.SUIBA_PERF_EVENT_LOOP_THRESHOLD_MS ?? "500",
  );
  detailed = installDetailedMetrics({
    databaseClass: BotDatabase,
    sqliteWriter: createBufferedJsonlWriter(join(dir, "sqlite-timing.jsonl")),
    spikeWriter: createBufferedJsonlWriter(
      join(dir, "event-loop-spikes.jsonl"),
    ),
    eventLoopThresholdMs:
      Number.isFinite(parsedThreshold) && parsedThreshold > 0
        ? parsedThreshold
        : 500,
  });
}
process.once("exit", () => {
  try {
    metrics.sample();
  } finally {
    metrics.stop();
  }
  if (detailed) {
    try {
      const status = detailed.stop();
      process.stdout.write(
        `${JSON.stringify({ event: "PREFLIGHT_PERF_DETAIL_STATUS", ...status })}\n`,
      );
    } catch {}
  }
});
