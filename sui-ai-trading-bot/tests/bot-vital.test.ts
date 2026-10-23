import { describe, expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import {
  botVital,
  VITAL_FETCH_DEADLINE_MS,
  VITAL_HEARTBEAT_FRESH_MS,
  VITAL_RECEIPT_FRESH_MS,
} from "../apps/dashboard/src/botVital.ts";
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
  // In production the heartbeat record is written by the same worker that
  // generated the snapshot, so it is never far behind `now`.
  d.lastHeartbeatAt = NOW - 5_000;
  return d;
}
/** Vital + summary as the hero renders them (summary follows evidenceStale). */
function pair(
  d: ReturnType<typeof fixture>,
  stale = false,
  receivedAt?: number,
) {
  const vital = botVital(d, stale, NOW, receivedAt ?? NOW);
  return { vital, summary: operationSummary(d, stale || vital.evidenceStale) };
}

describe("bot vital signs: stop state outranks connectivity", () => {
  it("STOPPED + RECOVERING never shows a weak heartbeat", () => {
    const d = fixture();
    d.safety.connectivity = "RECOVERING";
    const { vital, summary } = pair(d);
    expect(vital.state).toBe("sleeping");
    expect(vital.beatSeconds).toBeNull();
    expect(vital.ecg).toBe("flat");
    expect(summary.tone).toBe("stopped");
  });

  it("STOPPED + DEGRADED never shows a weak heartbeat", () => {
    const d = fixture();
    d.safety.connectivity = "DEGRADED";
    const { vital, summary } = pair(d);
    expect(vital.state).toBe("sleeping");
    expect(vital.beatSeconds).toBeNull();
    expect(summary.tone).toBe("stopped");
  });

  it("ABNORMAL_STOP + DEGRADED shows the safety stop, not a weak heartbeat", () => {
    const d = fixture();
    d.status = "ABNORMAL_STOP";
    d.safety.connectivity = "DEGRADED";
    const { vital, summary } = pair(d);
    expect(vital.state).toBe("flatlined");
    expect(vital.beatSeconds).toBeNull();
    expect(summary.title).toBe("安全停止");
  });

  it("EMERGENCY_STOP + RECOVERING shows the safety stop", () => {
    const d = healthy();
    d.safety.botState = "EMERGENCY_STOP";
    d.safety.connectivity = "RECOVERING";
    const { vital, summary } = pair(d);
    expect(vital.state).toBe("flatlined");
    expect(summary.title).toBe("安全停止");
  });

  it("RUNNING + RECOVERING / DEGRADED still shows the weak heartbeat", () => {
    const recovering = healthy();
    recovering.safety.connectivity = "RECOVERING";
    expect(pair(recovering).vital.state).toBe("weak");
    expect(pair(recovering).summary.title).toBe("復旧確認中");
    const degraded = healthy();
    degraded.safety.connectivity = "DEGRADED";
    expect(pair(degraded).vital.state).toBe("weak");
    expect(pair(degraded).summary.title).toBe("通信障害・一時待機");
  });
});

describe("bot vital signs: freshness", () => {
  it("RUNNING + stale display is unknown in both displays", () => {
    const { vital, summary } = pair(healthy(), true);
    expect(vital.state).toBe("unknown");
    expect(vital.beatSeconds).toBeNull();
    expect(summary.title).toBe("状態不明");
  });

  it("RUNNING + ordersAllowed=false is unknown in both displays", () => {
    const d = healthy();
    d.safety.ordersAllowed = false;
    const { vital, summary } = pair(d);
    expect(vital.state).toBe("unknown");
    expect(summary.title).toBe("状態不明");
  });

  it("downgrades to unknown when the worker heartbeat record is too old", () => {
    const d = healthy();
    d.lastHeartbeatAt = NOW - VITAL_HEARTBEAT_FRESH_MS - 1_000;
    const { vital, summary } = pair(d);
    expect(vital.state).toBe("unknown");
    expect(vital.evidenceStale).toBe(true);
    expect(vital.fetching).toBe(false);
    expect(summary.title).toBe("状態不明");
    // Exactly at the bound the evidence is still fresh.
    d.lastHeartbeatAt = NOW - VITAL_HEARTBEAT_FRESH_MS;
    expect(botVital(d, false, NOW, NOW).state).toBe("alive");
  });

  it("downgrades to unknown when the snapshot itself was received long ago", () => {
    const d = healthy();
    const receivedAt = NOW - VITAL_RECEIPT_FRESH_MS - 1_000;
    const { vital, summary } = pair(d, false, receivedAt);
    expect(vital.state).toBe("unknown");
    expect(vital.evidenceStale).toBe(true);
    expect(summary.title).toBe("状態不明");
    expect(botVital(d, false, NOW, NOW - 10_000).state).toBe("alive");
  });

  it("does not downgrade stopped states when evidence ages", () => {
    const d = fixture();
    d.lastHeartbeatAt = NOW - 3_600_000;
    const { vital, summary } = pair(d, false, NOW - 3_600_000);
    expect(vital.state).toBe("sleeping");
    expect(vital.evidenceStale).toBe(false);
    expect(summary.tone).toBe("stopped");
  });

  it("returns to alive after communication recovers", () => {
    const d = healthy();
    d.safety.connectivity = "DEGRADED";
    d.timing.dataStatus = "STALE";
    d.timing.transportRecent = false;
    expect(pair(d).vital.state).toBe("weak");
    d.safety.connectivity = "HEALTHY";
    d.timing.dataStatus = "FRESH";
    d.timing.transportRecent = true;
    d.lastHeartbeatAt = NOW - 1_000;
    const { vital, summary } = pair(d);
    expect(vital.state).toBe("alive");
    expect(vital.beatSeconds).toBe(1);
    expect(summary.title).toBe("正常稼働");
  });
});

describe("bot vital signs: fetching and next fetch", () => {
  it("shows fetching only for a credible in-progress fetch", () => {
    const d = healthy();
    d.timing.fetching = true;
    d.timing.fetchElapsedMs = 2_000;
    expect(botVital(d, false, NOW, NOW).fetching).toBe(true);
  });

  it("hides fetching when the worker stopped updating (old heartbeat)", () => {
    const d = healthy();
    d.timing.fetching = true;
    d.timing.fetchElapsedMs = 2_000;
    d.lastHeartbeatAt = NOW - VITAL_HEARTBEAT_FRESH_MS - 5_000;
    const v = botVital(d, false, NOW, NOW);
    expect(v.state).toBe("unknown");
    expect(v.fetching).toBe(false);
  });

  it("hides fetching past the worker's fetch deadline or without elapsed evidence", () => {
    const d = healthy();
    d.timing.fetching = true;
    d.timing.fetchElapsedMs = VITAL_FETCH_DEADLINE_MS + 1;
    expect(botVital(d, false, NOW, NOW).fetching).toBe(false);
    d.timing.fetchElapsedMs = null;
    expect(botVital(d, false, NOW, NOW).fetching).toBe(false);
  });

  it("hides fetching while stopped", () => {
    const d = fixture();
    d.timing.fetching = true;
    d.timing.fetchElapsedMs = 1_000;
    const v = botVital(d, false, NOW, NOW);
    expect(v.state).toBe("sleeping");
    expect(v.fetching).toBe(false);
  });

  it("reports an overdue next fetch instead of あと0秒", () => {
    const d = healthy();
    d.timing.nextFetchAt = NOW - 5_000;
    const v = botVital(d, false, NOW, NOW);
    expect(v.nextFetchSecondsIn).toBeNull();
    expect(v.nextFetchOverdueSeconds).toBe(5);
    d.timing.nextFetchAt = NOW;
    expect(botVital(d, false, NOW, NOW).nextFetchOverdueSeconds).toBe(0);
    d.timing.nextFetchAt = NOW + 30_200;
    const ahead = botVital(d, false, NOW, NOW);
    expect(ahead.nextFetchSecondsIn).toBe(31);
    expect(ahead.nextFetchOverdueSeconds).toBeNull();
  });

  it("reports real activity ages, keeping missing evidence null", () => {
    const d = healthy();
    d.timing.lastAnalysisAt = NOW - 65_000;
    d.timing.lastFetchSuccessAt = NOW - 3_400;
    d.lastHeartbeatAt = NOW - 15_000;
    const v = botVital(d, false, NOW, NOW);
    expect(v.lastAnalysisSecondsAgo).toBe(65);
    expect(v.lastFetchSecondsAgo).toBe(3);
    expect(v.heartbeatSecondsAgo).toBe(15);
    const bare = botVital(fixture(), false, NOW, NOW);
    expect(bare.lastAnalysisSecondsAgo).toBeNull();
    expect(bare.nextFetchSecondsIn).toBeNull();
    expect(bare.nextFetchOverdueSeconds).toBeNull();
  });
});

describe("bot vital signs: fetch elapsed ages on screen", () => {
  it("stops showing 取得中 once the on-screen age passes the fetch deadline", () => {
    const d = healthy();
    d.timing.fetching = true;
    d.timing.fetchElapsedMs = 44_000;
    // At receipt the fetch is still within its deadline.
    expect(botVital(d, false, NOW, NOW).fetching).toBe(true);
    // The snapshot value never changes, but 2s on screen ages it past 45s.
    const aged = botVital(d, false, NOW + 2_000, NOW);
    expect(aged.fetchElapsedMs).toBe(46_000);
    expect(aged.fetching).toBe(false);
    // The state itself is unaffected: only the 取得中 claim expires.
    expect(aged.state).toBe("alive");
    // Exactly at the deadline it is still credible.
    d.timing.fetchElapsedMs = 43_000;
    expect(botVital(d, false, NOW + 2_000, NOW).fetching).toBe(true);
  });

  it("ages a stuck fetchStartedAt across fresh snapshots (worker restart case)", () => {
    // fetchStartedAt persists in the DB while the worker's monotonic
    // fetch clock is gone, so snapshots keep arriving with
    // fetchElapsedMs = null and fetching = true.
    const d = healthy();
    d.timing.fetching = true;
    d.timing.fetchElapsedMs = null;
    d.timing.fetchStartedAt = NOW - 40_000;
    const first = botVital(d, false, NOW, NOW);
    expect(first.fetchElapsedMs).toBe(40_000);
    expect(first.fetching).toBe(true);
    // Ten seconds later a new snapshot arrives (fresh heartbeat, fresh
    // receipt) but the fetch start has not moved: it must expire.
    d.lastHeartbeatAt = NOW + 9_000;
    const later = botVital(d, false, NOW + 10_000, NOW + 10_000);
    expect(later.fetchElapsedMs).toBe(50_000);
    expect(later.fetching).toBe(false);
    expect(later.state).toBe("alive");
  });
});

describe("bot vital signs: weak heartbeat requires confirmed running", () => {
  it("does not beat weakly when botState contradicts running (MANUAL_STOP)", () => {
    const d = healthy();
    d.safety.botState = "MANUAL_STOP";
    d.safety.connectivity = "RECOVERING";
    const v = botVital(d, false, NOW, NOW);
    expect(v.state).not.toBe("weak");
    expect(v.state).not.toBe("alive");
    expect(v.beatSeconds).toBeNull();
    const degraded = healthy();
    degraded.safety.botState = "MANUAL_STOP";
    degraded.safety.connectivity = "DEGRADED";
    expect(botVital(degraded, false, NOW, NOW).beatSeconds).toBeNull();
  });

  it("does not beat weakly for an unrecognised status", () => {
    const d = healthy();
    d.status = "PAUSED" as typeof d.status;
    d.safety.connectivity = "DEGRADED";
    const v = botVital(d, false, NOW, NOW);
    expect(v.state).toBe("unknown");
    expect(v.beatSeconds).toBeNull();
  });

  it("still beats weakly while running (RUNNING and DATA_DELAYED)", () => {
    const recovering = healthy();
    recovering.safety.botState = "RECOVERING";
    recovering.safety.connectivity = "RECOVERING";
    expect(botVital(recovering, false, NOW, NOW).state).toBe("weak");
    const delayed = healthy();
    delayed.status = "DATA_DELAYED";
    delayed.safety.connectivity = "DEGRADED";
    expect(botVital(delayed, false, NOW, NOW).state).toBe("weak");
  });
});

describe("bot vital signs: summary consistency across combinations", () => {
  it("alive exactly matches 正常稼働, and beating states match live summaries", () => {
    const combos: [string, ReturnType<typeof fixture>, boolean?][] = [
      ["healthy", healthy()],
      [
        "ordersAllowed=false",
        Object.assign(healthy(), {
          safety: { ...healthy().safety, ordersAllowed: false },
        }),
      ],
      [
        "recovering",
        Object.assign(healthy(), {
          safety: { ...healthy().safety, connectivity: "RECOVERING" },
        }),
      ],
      [
        "degraded",
        Object.assign(healthy(), {
          safety: { ...healthy().safety, connectivity: "DEGRADED" },
        }),
      ],
      [
        "stopped+recovering",
        Object.assign(fixture(), {
          safety: { ...fixture().safety, connectivity: "RECOVERING" },
        }),
      ],
      [
        "abnormal+degraded",
        Object.assign(fixture(), {
          status: "ABNORMAL_STOP",
          safety: { ...fixture().safety, connectivity: "DEGRADED" },
        }),
      ],
      ["healthy+stale", healthy(), true],
    ];
    for (const [name, d, stale] of combos) {
      const { vital, summary } = pair(d, stale ?? false);
      expect(vital.state === "alive", name).toBe(summary.title === "正常稼働");
      if (vital.beatSeconds != null)
        expect(
          ["正常稼働", "復旧確認中", "通信障害・一時待機"],
          name,
        ).toContain(summary.title);
      if (vital.state === "sleeping")
        expect(summary.tone, name).toBe("stopped");
      if (vital.state === "flatlined")
        expect(summary.title, name).toBe("安全停止");
      if (vital.state === "unknown")
        expect(summary.title, name).toBe("状態不明");
    }
  });

  it("beats steadily only on the same evidence as the healthy summary", () => {
    const d = healthy();
    const v = botVital(d, false, NOW, NOW);
    expect(v.state).toBe("alive");
    expect(v.beatSeconds).toBe(1);
    expect(v.ecg).toBe("flowing");
    expect(operationSummary(d).title).toBe("正常稼働");
  });
});
