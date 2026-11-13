import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";

/** Offline display fixture: no network client, worker loop, or persistent database. */
export function dashboardPreviewFixture() {
  const db = new BotDatabase(":memory:");
  const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw Error("OFFLINE_PREVIEW");
      },
      validateQuote: async () => false,
    },
    { health: async () => health, status: health },
  );
  const state = engine.snapshot();
  const operations = engine.monitor.snapshot();
  const now = Date.now();
  operations.lastHeartbeatAt = now - 5000;
  operations.timing.lastAnalysisAt = now - 12000;
  operations.safety.lastStopReason = "MANUAL_STOP";
  operations.reports.find((r) => r.hours === 168)!.stopReasons = [
    { timestamp: now - 60000, reason: "MANUAL_STOP" },
  ];
  db.close();
  return { state, operations };
}
