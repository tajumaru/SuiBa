import { describe, expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { botVital } from "../apps/dashboard/src/botVital.ts";
import { operationSummary } from "../apps/dashboard/src/OperationOverview.tsx";

const NOW = 1_800_000_000_000;

function fixture() {
  const db = new BotDatabase(":memory:");
  const d = new OperationMonitor(db).snapshot(NOW);
  db.close();
  return d;
}
function healthy() {
  const d = fixture();
  d.status = "RUNNING";
  d.safety.botState = "RUNNING";
  d.safety.connectivity = "HEALTHY";
  d.safety.ordersAllowed = true;
  d.timing.dataStatus = "FRESH";
  d.timing.transportRecent = true;
  return d;
}

describe("bot vital signs", () => {
  it("does not beat while the bot is stopped", () => {
    const v = botVital(fixture(), false, NOW);
    expect(v.state).toBe("sleeping");
    expect(v.beatSeconds).toBeNull();
    expect(v.ecg).toBe("flat");
  });

  it("beats steadily only on the same evidence as the healthy summary", () => {
    const d = healthy();
    expect(operationSummary(d).title).toBe("正常稼働");
    const v = botVital(d, false, NOW);
    expect(v.state).toBe("alive");
    expect(v.beatSeconds).toBe(1);
    expect(v.ecg).toBe("flowing");
    // Losing order permission must stop the heartbeat too.
    d.safety.ordersAllowed = false;
    expect(botVital(d, false, NOW).state).toBe("unknown");
    expect(botVital(d, false, NOW).beatSeconds).toBeNull();
  });

  it("flattens on a safety stop and slows while recovering or degraded", () => {
    const stopped = fixture();
    stopped.status = "ABNORMAL_STOP";
    expect(operationSummary(stopped).title).toBe("安全停止");
    expect(botVital(stopped, false, NOW).state).toBe("flatlined");
    expect(botVital(stopped, false, NOW).ecg).toBe("flat");

    const recovering = healthy();
    recovering.safety.connectivity = "RECOVERING";
    const v = botVital(recovering, false, NOW);
    expect(v.state).toBe("weak");
    expect(v.beatSeconds).toBeGreaterThan(1);
    expect(v.ecg).toBe("slow");

    const degraded = healthy();
    degraded.safety.connectivity = "DEGRADED";
    expect(botVital(degraded, false, NOW).state).toBe("weak");
  });

  it("never beats on a stale display", () => {
    const v = botVital(healthy(), true, NOW);
    expect(v.state).toBe("unknown");
    expect(v.beatSeconds).toBeNull();
    expect(v.ecg).toBe("flat");
  });

  it("reports real activity ages and the next-fetch countdown", () => {
    const d = healthy();
    d.timing.fetching = true;
    d.timing.lastAnalysisAt = NOW - 65_000;
    d.timing.lastFetchSuccessAt = NOW - 3_400;
    d.timing.nextFetchAt = NOW + 30_200;
    d.lastHeartbeatAt = NOW - 15_000;
    const v = botVital(d, false, NOW);
    expect(v.fetching).toBe(true);
    expect(v.lastAnalysisSecondsAgo).toBe(65);
    expect(v.lastFetchSecondsAgo).toBe(3);
    expect(v.heartbeatSecondsAgo).toBe(15);
    expect(v.nextFetchSecondsIn).toBe(31);
    // A next fetch in the past clamps to zero instead of going negative.
    d.timing.nextFetchAt = NOW - 5_000;
    expect(botVital(d, false, NOW).nextFetchSecondsIn).toBe(0);
    // Missing evidence stays null rather than becoming a fake age.
    const bare = botVital(fixture(), false, NOW);
    expect(bare.lastAnalysisSecondsAgo).toBeNull();
    expect(bare.nextFetchSecondsIn).toBeNull();
  });
});
