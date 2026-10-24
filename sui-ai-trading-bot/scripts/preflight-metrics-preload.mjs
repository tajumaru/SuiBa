import "./enforce-node-version.mjs";
import { BotDatabase } from "../packages/database/src/index.ts";
import { installPreflightMetrics } from "./preflight-passive-metrics.mjs";
const metrics = installPreflightMetrics(BotDatabase.prototype, (record) => {
  // Docker captures stdout. Refuse backpressure instead of queuing unbounded evidence.
  if (!process.stdout.write(JSON.stringify(record) + "\n"))
    throw Error("VALIDATION_RECORD_FAILED");
});
process.once("exit", () => {
  try {
    metrics.sample();
  } finally {
    metrics.stop();
  }
});
