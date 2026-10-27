import { afterEach, describe, expect, it, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { DashboardService } from "../apps/worker/src/dashboard-feed.ts";
import type { DatabaseSync } from "node:sqlite";
import { botVital } from "../apps/dashboard/src/botVital.ts";
import {
  advanceNarration,
  agentPose,
  currentConditionChips,
  currentWatch,
  currentWatchScore,
  cycleNarrationText,
  decisionTrail,
  emptyNarrationState,
  entryConditionChips,
  MAX_NARRATION_ENTRIES,
  reviewNarrationTexts,
  spikeAlert,
  type NarrationState,
} from "../apps/dashboard/src/agentNarration.ts";
import type { DecisionTelemetry } from "../apps/worker/src/operations.ts";
import type { TradingDecision } from "../packages/shared/src/index.ts";
import type {
  CandidateAudit,
  OperationEvent,
} from "../packages/shared/src/operations.ts";
import type { ApiFailure } from "../packages/shared/src/http-errors.ts";

const NOW = 1_800_000_000_000;
const databases: BotDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function decision(overrides: {
  evaluatedAt?: number;
  action?: TradingDecision["action"];
  selectedRule?: string;
  sellPurpose?: TradingDecision["sellPurpose"];
  price?: number;
  entryPrice?: number | null;
  ema20?: number;
  ema50?: number;
  rsi?: number;
  previousRsi?: number;
  histogram?: number;
  previousHistogram?: number;
  volumeChange?: number;
  rsiLinePrice?: number | null;
  conditions?: Record<string, boolean>;
}): TradingDecision {
  const o = overrides;
  const conditions = {
    hasPosition: false,
    stopLoss: false,
    takeProfit: false,
    latestVolumePositive: true,
    previousVolumePositive: true,
    volumeChangeExceeded: false,
    emaUp: false,
    emaGapShrinking: false,
    rsiRecovery: false,
    histogramImproving: false,
    emaDown: true,
    rsiReversal: false,
    histogramDeclining: true,
    ...(o.conditions ?? {}),
  };
  return {
    action: o.action ?? "WAIT",
    confidence: 0,
    reason: "条件未成立",
    stopLossPct: 0.02,
    takeProfitPct: 0.03,
    timestamp: new Date(o.evaluatedAt ?? NOW - 60_000).toISOString(),
    sellPurpose: o.sellPurpose,
    evidence: {
      version: 1,
      evaluatedAt: o.evaluatedAt ?? NOW - 60_000,
      candleTimestamp: (NOW - 600_000) / 1000,
      previousCandleTimestamp: (NOW - 900_000) / 1000,
      inputs: {
        price: o.price ?? 2.4,
        latestVolume: 1000,
        previousVolume: 900,
        entryPrice: o.entryPrice ?? null,
        current: {
          ema20: o.ema20 ?? 2.38,
          ema50: o.ema50 ?? 2.42,
          rsi: o.rsi ?? 44,
          macd: 0.001,
          signal: 0.002,
          histogram: o.histogram ?? -0.003,
          atr: 0.02,
          volumeChange: o.volumeChange ?? 0.05,
          priceChange: 0.001,
        },
        previous: {
          ema20: 2.37,
          ema50: 2.42,
          rsi: o.previousRsi ?? 42,
          macd: 0.0005,
          signal: 0.002,
          histogram: o.previousHistogram ?? -0.002,
          atr: 0.02,
          volumeChange: 0.03,
          priceChange: 0,
        },
      },
      thresholds: {
        oversold: 30,
        overbought: 70,
        maxVolumeChange: 3,
        stopLossPct: 0.02,
        takeProfitPct: 0.03,
      },
      conditions,
      selectedRule: o.selectedRule ?? "NO_SIGNAL",
      rsiLinePrice: o.rsiLinePrice ?? null,
    },
  };
}

function fixture() {
  const db = new BotDatabase(":memory:");
  databases.push(db);
  const monitor = new OperationMonitor(db);
  return { db, monitor };
}

/** A snapshot whose hero would judge the bot alive (mirrors bot-vital tests). */
function runningSnapshot(
  db: BotDatabase,
  monitor: OperationMonitor,
  dec?: TradingDecision | null,
) {
  if (dec) db.set("decision", dec);
  const d = monitor.snapshot(NOW);
  d.status = "RUNNING";
  d.safety.botState = "RUNNING";
  d.safety.connectivity = "HEALTHY";
  d.safety.ordersAllowed = true;
  d.timing.dataStatus = "FRESH";
  d.timing.transportRecent = true;
  d.timing.lastTransportSuccessAt = NOW - 1_000;
  d.lastHeartbeatAt = NOW - 5_000;
  d.lastMarketClosedAt = NOW - 300_000;
  return d;
}

function apiEvent(
  at: number,
  api: string,
  code = "UPSTREAM_HTTP_503",
): OperationEvent {
  const failure: ApiFailure = {
    api,
    url: "https://example.invalid",
    host: "example.invalid",
    operation: "read",
    method: "GET",
    code,
    causeCode: null,
    phase: "HTTP",
    status: 503,
    elapsedMs: 100,
    occurredAt: at,
  };
  return { timestamp: at, kind: "API", code, apiFailure: failure };
}

function candidate(overrides: Partial<CandidateAudit>): CandidateAudit {
  return {
    id: "cand-1",
    orderId: "order-1",
    timestamp: NOW - 30_000,
    createdAt: NOW - 30_000,
    side: "BUY",
    requestedInputAtomic: "10000000",
    quantityAtomic: "500000000",
    quotePriceUsdc: "2.4312",
    quoteExpiresAt: null,
    acquisitionCostUsdc: null,
    expectedSaleUsdc: null,
    saleModel: null,
    dexFeeUsdc: null,
    gasUsdc: null,
    additionalFeeUsdc: null,
    buyGasUsdc: null,
    netProfitUsdc: null,
    minProfitUsdc: "0",
    minProfitPct: "0",
    profitGuard: { evaluated: true, allowed: true, reason: null },
    risk: { status: "ALLOWED", reasons: [] },
    finalAction: "BUY",
    reasons: [],
    ...overrides,
  };
}

describe("worker decision telemetry (read-only, fail-closed)", () => {
  it("normalizes real seconds-based candle evidence to its close time in milliseconds", () => {
    const { db, monitor } = fixture();
    const dec = decision({ evaluatedAt: NOW - 10_000 });
    dec.evidence!.candleTimestamp = (NOW - 550_000) / 1000;
    db.set("decision", dec);
    const snapshot = runningSnapshot(db, monitor);
    expect(snapshot.decision?.candleTimestamp).toBe(NOW - 250_000);
    expect(snapshot.decision?.evaluatedAt).toBe(NOW - 10_000);
    const state = advanceNarration(
      emptyNarrationState(),
      snapshot,
      "alive",
      NOW,
    );
    expect(state.entries.some((entry) => entry.kind === "cycle")).toBe(true);
    expect(db.get<TradingDecision>("decision")!.evidence!.candleTimestamp).toBe(
      dec.evidence!.candleTimestamp,
    );
  });

  it.each(["stale", "unclosed", "milliseconds", "fractional"])(
    "rejects %s candle evidence without weakening freshness limits",
    (kind) => {
      const { db, monitor } = fixture();
      const dec = decision({ evaluatedAt: NOW });
      dec.evidence!.candleTimestamp =
        kind === "stale"
          ? (NOW - 661_000) / 1000
          : kind === "unclosed"
            ? (NOW - 100_000) / 1000
            : kind === "milliseconds"
              ? NOW - 300_000
              : (NOW - 600_000) / 1000 + 0.5;
      db.set("decision", dec);
      expect(monitor.snapshot(NOW).decision).toBeNull();
    },
  );

  it("is null when no decision was recorded", () => {
    const { monitor } = fixture();
    expect(monitor.snapshot(NOW).decision).toBeNull();
  });

  it("copies the recorded evidence with its real values", () => {
    const { db, monitor } = fixture();
    db.set("decision", decision({ rsi: 28, previousRsi: 33 }));
    const t = monitor.snapshot(NOW).decision;
    expect(t).not.toBeNull();
    expect(t!.rsi).toBe(28);
    expect(t!.previousRsi).toBe(33);
    expect(t!.conditions.emaUp).toBe(false);
    expect(t!.oversold).toBe(30);
    expect(t!.action).toBe("WAIT");
  });

  it("is null for an unknown evidence version", () => {
    const { db, monitor } = fixture();
    const dec = decision({});
    (dec.evidence as { version: number }).version = 2;
    db.set("decision", dec);
    expect(monitor.snapshot(NOW).decision).toBeNull();
  });

  it("is null when a value is not a finite number", () => {
    const { db, monitor } = fixture();
    const dec = decision({});
    dec.evidence!.inputs.current.rsi = Number.NaN;
    db.set("decision", dec);
    expect(monitor.snapshot(NOW).decision).toBeNull();
  });

  it("is null when a narrated condition is missing", () => {
    const { db, monitor } = fixture();
    const dec = decision({});
    delete (dec.evidence!.conditions as Record<string, unknown>)
      .histogramImproving;
    db.set("decision", dec);
    expect(monitor.snapshot(NOW).decision).toBeNull();
  });

  it("is null for the evidence-less fallback decision the engine stores on failure", () => {
    const { db, monitor } = fixture();
    db.set("decision", { action: "WAIT", reason: "SOME_CODE", confidence: 0 });
    expect(monitor.snapshot(NOW).decision).toBeNull();
  });
});

describe("agent narration: initialisation", () => {
  it("a stopped bot gets one status entry and the sleep pose", () => {
    const { monitor } = fixture();
    const d = monitor.snapshot(NOW);
    const state = advanceNarration(
      emptyNarrationState(),
      d,
      botVital(d, false, NOW, NOW).state,
      NOW,
    );
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].text).toContain("停止中だよ");
    const vital = botVital(d, false, NOW, NOW);
    expect(agentPose(state, d, vital, NOW)).toBe("sleep");
  });

  it("a running bot narrates its latest recorded cycle with real numbers", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].kind).toBe("cycle");
    expect(state.entries[0].text).toContain("EMAの差は-1.6667%");
    expect(state.entries[0].text).toContain("遠いなあ");
    // Re-advancing the very same snapshot adds nothing.
    const again = advanceNarration(state, d, "alive", NOW);
    expect(again.entries).toHaveLength(1);
  });
});

describe("agent narration: cycles", () => {
  function twoCycles() {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor, decision({}));
    let state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const d2 = runningSnapshot(
      db,
      monitor,
      decision({
        evaluatedAt: NOW,
        conditions: { rsiRecovery: true, histogramImproving: true },
        histogram: -0.001,
        previousHistogram: -0.002,
      }),
    );
    state = advanceNarration(state, d2, "alive", NOW);
    return { state, d2 };
  }

  it("a new cycle with 2/3 conditions met names the one remaining and points", () => {
    const { state, d2 } = twoCycles();
    // The watched MACD clicked this cycle, so the cycle line is
    // framed by the watch hit and the next declaration.
    const texts = state.entries.map((e) => e.text);
    expect(texts.some((t) => t.includes("あとEMAだけ"))).toBe(true);
    const vital = botVital(d2, false, NOW, NOW);
    expect(agentPose(state, d2, vital, NOW)).toBe("point");
  });

  it("the featured unmet condition follows the evidence (RSI in the zone)", () => {
    const text = cycleNarrationText(
      {
        evaluatedAt: NOW,
        candleTimestamp: NOW,
        action: "WAIT" as const,
        reason: "",
        selectedRule: "NO_SIGNAL",
        sellPurpose: null,
        price: 2.4,
        entryPrice: null,
        ema20: 2.3,
        ema50: 2.42,
        rsi: 28,
        previousRsi: 33,
        histogram: -0.001,
        previousHistogram: -0.002,
        atr: 0.02,
        volumeChange: 0.05,
        oversold: 30,
        overbought: 70,
        stopLossPct: 0.02,
        takeProfitPct: 0.03,
        rsiLinePrice: null,
        conditions: {
          emaUp: false,
          emaGapShrinking: false,
          rsiRecovery: false,
          histogramImproving: true,
          hasPosition: false,
          stopLoss: false,
          takeProfit: false,
        },
      },
      null,
    );
    expect(text).toContain("RSIは28で圏内、上抜け待ち");
    expect(text).toContain("条件は1/3だね");
  });

  it("a condition that was met and then breaks narrates a step back", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(
      db,
      monitor,
      decision({
        conditions: { histogramImproving: true },
        histogram: -0.001,
        previousHistogram: -0.002,
      }),
    );
    let state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const d2 = runningSnapshot(
      db,
      monitor,
      decision({
        evaluatedAt: NOW,
        histogram: -0.003,
        previousHistogram: -0.001,
      }),
    );
    state = advanceNarration(state, d2, "alive", NOW);
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1].text).toContain("MACDが崩れて-0.003");
    expect(state.entries[1].text).toContain("一歩さがったなあ");
  });

  it("identical consecutive cycle evidence is not narrated twice", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor, decision({}));
    let state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const d2 = runningSnapshot(db, monitor, decision({ evaluatedAt: NOW }));
    state = advanceNarration(state, d2, "alive", NOW);
    expect(state.entries).toHaveLength(1);
  });

  it("a position watch narrates entry price, current price and the guard lines", () => {
    const text = cycleNarrationText(
      {
        evaluatedAt: NOW,
        candleTimestamp: NOW,
        action: "WAIT",
        reason: "",
        selectedRule: "NO_SIGNAL",
        sellPurpose: null,
        price: 2.4,
        entryPrice: 2.3,
        ema20: 2.41,
        ema50: 2.4,
        rsi: 55,
        previousRsi: 54,
        histogram: 0.001,
        previousHistogram: 0.001,
        atr: 0.02,
        volumeChange: 0.01,
        oversold: 30,
        overbought: 70,
        stopLossPct: 0.02,
        takeProfitPct: 0.03,
        rsiLinePrice: null,
        conditions: {
          emaUp: true,
          emaGapShrinking: false,
          rsiRecovery: false,
          histogramImproving: false,
          hasPosition: true,
          stopLoss: false,
          takeProfit: false,
        },
      },
      null,
    );
    expect(text).toContain("保有中だよ");
    expect(text).toContain("取得2.3 USDCから今は+4.3478%");
  });

  it("a volume rejection narrates the measured volume change", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(
      db,
      monitor,
      decision({ selectedRule: "VOLUME_REJECT", volumeChange: 3.5 }),
    );
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(state.entries[0].text).toContain(
      "出来高が急に変わったから見送ったよ",
    );
    expect(state.entries[0].text).toContain("350%");
  });

  it("a huge volume change narrates as a multiple, not an astronomical percent", () => {
    const { db, monitor } = fixture();
    // A change off a nearly empty previous candle: 49 as a percent
    // would print +4,900% and far worse for thinner bases.
    const d = runningSnapshot(
      db,
      monitor,
      decision({ selectedRule: "VOLUME_REJECT", volumeChange: 49 }),
    );
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(state.entries[0].text).toBe(
      "出来高が急に変わったから見送ったよ。変化は約50倍だね",
    );
  });

  it("the multiple switch sits at a change of nine (ten times the volume)", () => {
    const { db, monitor } = fixture();
    const at = runningSnapshot(
      db,
      monitor,
      decision({ selectedRule: "VOLUME_REJECT", volumeChange: 9 }),
    );
    expect(
      advanceNarration(emptyNarrationState(), at, "alive", NOW).entries[0].text,
    ).toContain("変化は約10倍だね");
    const below = runningSnapshot(
      db,
      monitor,
      decision({ selectedRule: "VOLUME_REJECT", volumeChange: 8.9 }),
    );
    expect(
      advanceNarration(emptyNarrationState(), below, "alive", NOW).entries[0]
        .text,
    ).toContain("変化は890%だね");
  });

  it("a non-finite volume change never reaches the narration", () => {
    const { db, monitor } = fixture();
    // The worker's telemetry validation is fail-closed on
    // non-finite numbers, so an infinite change cannot be
    // narrated — and the display-side guard keeps it that way
    // even if one ever slipped through.
    const d = runningSnapshot(
      db,
      monitor,
      decision({
        selectedRule: "VOLUME_REJECT",
        volumeChange: Number.POSITIVE_INFINITY,
      }),
    );
    expect(d.decision).toBeNull();
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(
      state.entries.every(
        (e) => !e.text.includes("Infinity") && !e.text.includes("∞"),
      ),
    ).toBe(true);
  });
});

describe("agent narration: trades and rejections from candidate audits", () => {
  it("a recorded PAPER buy narrates quantity and price, then smiles", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor, decision({}));
    let state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const d2 = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW, action: "BUY", selectedRule: "BUY_SIGNAL" }),
    );
    d2.candidates = [
      candidate({ timestamp: NOW + 1000, createdAt: NOW + 1000 }),
    ];
    state = advanceNarration(state, d2, "alive", NOW + 1000);
    const trade = state.entries.at(-1)!;
    expect(trade.kind).toBe("trade");
    expect(trade.text).toContain("PAPERで買いを記録したよ");
    expect(trade.text).toContain("0.5 SUI");
    expect(trade.text).toContain("2.4312 USDC");
    const vital = botVital(d2, false, NOW, NOW);
    expect(agentPose(state, d2, vital, NOW + 1000)).toBe("pointSmile");
  });

  it("a gate rejection narrates the recorded reason in Japanese", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor, decision({}));
    let state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const d2 = runningSnapshot(db, monitor, decision({ evaluatedAt: NOW }));
    d2.candidates = [
      candidate({
        id: "cand-2",
        finalAction: "WAIT",
        reasons: ["MINIMUM_NET_PROFIT_NOT_MET"],
        timestamp: NOW + 500,
        createdAt: NOW + 500,
      }),
    ];
    state = advanceNarration(state, d2, "alive", NOW + 500);
    const rejection = state.entries.at(-1)!;
    expect(rejection.kind).toBe("rejection");
    expect(rejection.text).toContain("買いシグナルは出たけど、見送ったよ");
    expect(rejection.text).toContain(
      "手数料込みの利益が基準に届かないため見送り",
    );
  });
});

describe("agent narration: events", () => {
  function started() {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    return { db, monitor, state };
  }

  it("STOP and API events narrate; a same-timestamp ERROR does not repeat the API story", () => {
    const { db, monitor, state } = started();
    const d = runningSnapshot(db, monitor, decision({ evaluatedAt: NOW }));
    const at = NOW + 2000;
    d.events = [
      { timestamp: at, kind: "ERROR", code: "MARKET_UPSTREAM_HTTP_503" },
      apiEvent(at, "DeepBook"),
      { timestamp: at + 1000, kind: "STOP", code: "CONSECUTIVE_API_ERRORS" },
    ];
    const next = advanceNarration(state, d, "alive", at + 1000);
    const texts = next.entries.map((e) => e.text);
    expect(texts.some((t) => t.includes("DeepBookと通信できなかったよ"))).toBe(
      true,
    );
    expect(texts.some((t) => t.includes("処理でエラーが出たよ"))).toBe(false);
    expect(
      texts.some((t) =>
        t.includes("止まったよ。理由：APIの連続エラーを検出しました"),
      ),
    ).toBe(true);
  });

  it("connectivity transitions narrate degradation and recovery once", () => {
    const { db, monitor, state } = started();
    const degraded = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW }),
    );
    degraded.safety.connectivity = "DEGRADED";
    const s2 = advanceNarration(state, degraded, "weak", NOW);
    expect(s2.entries.at(-1)!.text).toContain("通信が不安定だよ");
    const recovering = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW }),
    );
    recovering.safety.connectivity = "RECOVERING";
    recovering.safety.healthyCycles = 2;
    const s3 = advanceNarration(s2, recovering, "weak", NOW);
    expect(s3.entries.at(-1)!.text).toContain("正常サイクル2回");
    const healthyAgain = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW }),
    );
    const s4 = advanceNarration(s3, healthyAgain, "alive", NOW);
    expect(s4.entries.at(-1)!.kind).toBe("recovery");
    expect(s4.entries.at(-1)!.text).toContain("通信が復旧したよ");
  });

  it("entries are capped", () => {
    const { db, monitor, state } = started();
    const d = runningSnapshot(db, monitor, decision({ evaluatedAt: NOW }));
    d.events = Array.from({ length: 40 }, (_, i) =>
      apiEvent(NOW + 1000 + i, `API${i}`),
    );
    const next = advanceNarration(state, d, "alive", NOW + 5000);
    expect(next.entries.length).toBe(MAX_NARRATION_ENTRIES);
  });
});

describe("agent pose", () => {
  it("points for one met condition when the recorded price rises", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({ price: 2.4 }));
    const prev = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    const next = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW, price: 2.5, conditions: { emaUp: true } }),
    );
    const state = advanceNarration(prev, next, "alive", NOW);
    expect(agentPose(state, next, botVital(next, false, NOW, NOW), NOW)).toBe(
      "point",
    );
  });

  it("weak (degraded) works at the laptop and never points, even with 2/3 conditions met", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(
      db,
      monitor,
      decision({
        conditions: { rsiRecovery: true, histogramImproving: true },
      }),
    );
    d.safety.connectivity = "DEGRADED";
    const vital = botVital(d, false, NOW, NOW);
    expect(vital.state).toBe("weak");
    expect(agentPose(emptyNarrationState(), d, vital, NOW)).toBe("laptop");
  });

  it("a safety stop sleeps", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    d.status = "ABNORMAL_STOP";
    d.safety.botState = "ABNORMAL_STOP";
    const vital = botVital(d, false, NOW, NOW);
    expect(vital.state).toBe("flatlined");
    expect(agentPose(emptyNarrationState(), d, vital, NOW)).toBe("sleep");
  });

  it("an alive bot with fewer than two conditions met works at the laptop", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const vital = botVital(d, false, NOW, NOW);
    expect(vital.state).toBe("alive");
    expect(agentPose(emptyNarrationState(), d, vital, NOW)).toBe("laptop");
  });

  it("an unconfirmed (unknown) state keeps the normal pose, never the laptop", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const vital = botVital(d, false, NOW, NOW);
    expect(vital.state).toBe("alive");
    // With the run state unconfirmed the agent must not claim to be
    // working: the plain pose stays.
    expect(
      agentPose(emptyNarrationState(), d, { ...vital, state: "unknown" }, NOW),
    ).toBe("normal");
  });
});

describe("agent narration: fail-closed", () => {
  it("keeps display snapshots available for actually corrupted stored decision JSON", () => {
    const { db, monitor } = fixture();
    db.set("decision", decision({}));
    (db as unknown as { db: DatabaseSync }).db
      .prepare("UPDATE bot_runtime_state SET json=? WHERE key=?")
      .run("{", "decision");
    const health = { healthy: true, checkedAt: NOW, failures: 0 };
    const engine = new BotEngine(
      db,
      { candles: async () => [] },
      {
        getQuote: async () => {
          throw new Error("UNEXPECTED_ORDER");
        },
        validateQuote: async () => false,
      },
      { health: async () => health, status: health },
    );
    expect(monitor.snapshot(NOW).decision).toBeNull();
    expect(engine.snapshot().decision).toBeNull();
    expect(
      new DashboardService(engine, db).summary().summary.decision,
    ).toBeNull();
    expect(db.health().healthy).toBe(true);
  });
  it.each(["BUY", "WAIT", "SAFE_STOP"] as const)(
    "narrates PENDING -> %s once, including after reconnect",
    (finalAction) => {
      const { db, monitor } = fixture();
      const d = runningSnapshot(db, monitor, decision({}));
      d.candidates = [candidate({ finalAction: "PENDING" })];
      const first = advanceNarration(emptyNarrationState(), d, "alive", NOW);
      d.candidates = [candidate({ finalAction })];
      const next = advanceNarration(first, d, "alive", NOW);
      expect(next.entries).toHaveLength(first.entries.length + 1);
      const again = advanceNarration(next, structuredClone(d), "alive", NOW);
      expect(again.entries).toEqual(next.entries);
      expect(again.entries).toBe(next.entries);
    },
  );

  it.each([-1, 0, NOW + 1, NOW - 360_001, 9e20])(
    "rejects invalid or expired decision time %s",
    (at) => {
      const { db, monitor } = fixture();
      const dec = decision({});
      dec.evidence!.evaluatedAt = at;
      db.set("decision", dec);
      expect(monitor.snapshot(NOW).decision).toBeNull();
    },
  );

  it("rejects malformed optional telemetry without changing persisted state or gates", () => {
    const { db, monitor } = fixture();
    const before = monitor.snapshot(NOW);
    const gate = monitor.ordersAllowed(undefined, NOW);
    const set = vi.spyOn(db, "set");
    const get = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation((key) => {
      if (key === "decision") throw new SyntaxError("invalid JSON");
      return get(key);
    });
    expect(monitor.snapshot(NOW)).toEqual(before);
    expect(monitor.ordersAllowed(undefined, NOW)).toBe(gate);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([
    new Error("display read failed"),
    new TypeError("invalid display data"),
  ])("isolates optional read failure %s in all display snapshots", (error) => {
    const { db, monitor } = fixture();
    const health = { healthy: true, checkedAt: NOW, failures: 0 };
    const engine = new BotEngine(
      db,
      { candles: async () => [] },
      {
        getQuote: async () => {
          throw new Error("UNEXPECTED_ORDER");
        },
        validateQuote: async () => false,
      },
      { health: async () => health, status: health },
    );
    const before = monitor.snapshot(NOW);
    const get = db.get.bind(db);
    const set = vi.spyOn(db, "set");
    vi.spyOn(db, "get").mockImplementation((key) => {
      if (key === "decision") throw error;
      return get(key);
    });
    expect(monitor.snapshot(NOW)).toEqual(before);
    expect(engine.snapshot().decision).toBeNull();
    expect(
      new DashboardService(engine, db).summary().summary.decision,
    ).toBeNull();
    expect(db.health().healthy).toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([5, 11, 10, 6])(
    "keeps SQLite fault classification and immediate safety state for telemetry errcode %s",
    (errcode) => {
      const { db, monitor } = fixture();
      db.set("runtime", { ...db.runtime(), running: true });
      monitor.market(NOW, NOW - 300_000);
      const get = db.get.bind(db);
      const sql = (db as unknown as { sql<T>(fn: () => T): T }).sql.bind(db);
      vi.spyOn(db, "get").mockImplementation((key) => {
        if (key === "decision")
          return sql(() => {
            throw Object.assign(new Error("fixture SQL read failure"), {
              errcode,
            });
          });
        return get(key);
      });
      const snapshot = monitor.snapshot(NOW);
      expect(snapshot.decision).toBeNull();
      expect(db.health()).toMatchObject({
        healthy: errcode === 5,
        requiresRestart: errcode !== 5,
      });
      if (errcode !== 5) {
        expect(snapshot.status).toBe("ABNORMAL_STOP");
        expect(snapshot.stopReason).toBe("DATABASE_UNAVAILABLE");
        expect(snapshot.safety.botState).toBe("ABNORMAL_STOP");
        expect(snapshot.safety.ordersAllowed).toBe(false);
        expect(db.runtime()).toMatchObject({
          running: false,
          error: "DATABASE_UNAVAILABLE",
        });
        expect(() => db.set("runtime", { running: true })).toThrow(
          "DATABASE_UNAVAILABLE",
        );
        vi.restoreAllMocks();
        expect(db.health().healthy).toBe(false);
        expect(monitor.ordersAllowed(undefined, NOW)).toBe(false);
      }
      expect(db.history("paper_orders")).toEqual([]);
      expect(db.history("paper_trades")).toEqual([]);
    },
  );

  it("still propagates faults outside optional decision data", () => {
    const { db, monitor } = fixture();
    const get = db.get.bind(db);
    vi.spyOn(db, "get").mockImplementation((key) => {
      if (key === "portfolio") throw new Error("DATABASE_UNAVAILABLE");
      return get(key);
    });
    expect(() => monitor.snapshot(NOW)).toThrow("DATABASE_UNAVAILABLE");
  });

  it.each(["candle", "price", "entry", "rsi", "threshold", "rule", "purpose"])(
    "rejects malformed %s evidence",
    (field) => {
      const { db, monitor } = fixture();
      const dec = decision({});
      const evidence = dec.evidence!;
      if (field === "candle") evidence.candleTimestamp = NOW - 360_001;
      if (field === "price") evidence.inputs.price = -1;
      if (field === "entry") evidence.inputs.entryPrice = 0;
      if (field === "rsi") evidence.inputs.current.rsi = 101;
      if (field === "threshold") evidence.thresholds.stopLossPct = 2;
      if (field === "rule")
        (evidence as unknown as Record<string, unknown>).selectedRule = {};
      if (field === "purpose")
        (dec as unknown as Record<string, unknown>).sellPurpose = {};
      db.set("decision", dec);
      expect(monitor.snapshot(NOW).decision).toBeNull();
    },
  );

  it("expires a trade pose even when no new narration arrives", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, null);
    const state = emptyNarrationState();
    state.entries = [{ id: "trade", at: NOW, kind: "trade", text: "recorded" }];
    const vital = botVital(d, false, NOW, NOW);
    expect(agentPose(state, d, vital, NOW)).toBe("pointSmile");
    expect(agentPose(state, d, vital, NOW + 360_001)).toBe("laptop");
  });

  it("flashes the smug smile for a fresh watch hit, then lets it expire", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, null);
    const state = emptyNarrationState();
    state.lastHitAt = NOW;
    const vital = botVital(d, false, NOW, NOW);
    expect(agentPose(state, d, vital, NOW)).toBe("pointSmile");
    expect(agentPose(state, d, vital, NOW + 360_001)).toBe("laptop");
  });

  it("does not narrate or point for old/future evidence or unconfirmed running state", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(
      db,
      monitor,
      decision({ conditions: { emaUp: true, rsiRecovery: true } }),
    );
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    const vital = botVital(d, false, NOW, NOW);
    for (const at of [NOW - 360_001, NOW + 1]) {
      d.decision!.evaluatedAt = at;
      expect(
        advanceNarration(emptyNarrationState(), d, "alive", NOW).entries[0]
          .kind,
      ).toBe("status");
      expect(agentPose(state, d, vital, NOW)).toBe("laptop");
    }
    d.decision!.evaluatedAt = NOW;
    expect(advanceNarration(state, d, "unknown", NOW).entries).toEqual(
      state.entries,
    );
    for (const stopped of ["sleeping", "flatlined"] as const) {
      expect(advanceNarration(state, d, stopped, NOW).entries).toEqual(
        state.entries,
      );
      expect(agentPose(state, d, { ...vital, state: stopped }, NOW)).toBe(
        "sleep",
      );
    }
  });

  it("keeps visible old records deduplicated through long sessions with bounded memory", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const old = candidate({});
    d.candidates = [old];
    let state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    for (let i = 0; i < 1000; i++) {
      d.events = [apiEvent(NOW + i, `API${i}`)];
      state = advanceNarration(state, d, "alive", NOW + i);
      expect(state.entries.length).toBeLessThanOrEqual(30);
      expect(state.seen.length).toBeLessThanOrEqual(200);
    }
    expect(state.entries.every((entry) => entry.kind !== "trade")).toBe(true);
    expect(
      advanceNarration(state, structuredClone(d), "alive", NOW + 1000).entries,
    ).toBe(state.entries);
  });

  it("keeps React keys unique when same-timestamp entries arrive after the history cap", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    let state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    for (let i = 0; i < 60; i++) {
      d.events = [apiEvent(NOW, `API${i}`)];
      state = advanceNarration(state, d, "alive", NOW);
    }
    expect(state.entries).toHaveLength(30);
    expect(new Set(state.entries.map((e) => e.id)).size).toBe(30);
  });

  it("does not replay evicted events or final candidates when old pages return after reconnect", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    let state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    const oldEvent = apiEvent(NOW + 1, "evicted-old-api");
    const oldCandidate = candidate({
      id: "evicted-old-fill",
      createdAt: NOW + 1,
      timestamp: NOW + 1,
    });
    for (let i = 1; i <= 1000; i++) {
      d.events = [i === 1 ? oldEvent : apiEvent(NOW + i, `API${i}`)];
      d.candidates = [
        i === 1
          ? oldCandidate
          : candidate({
              id: `fill-${i}`,
              createdAt: NOW + i,
              timestamp: NOW + i,
              quotePriceUsdc: String(i),
            }),
      ];
      state = advanceNarration(state, d, "alive", NOW + i);
    }
    expect(state.seen).toHaveLength(200);
    expect(state.seen.some((key) => key.includes("evicted-old"))).toBe(false);
    const entries = state.entries;
    d.events = [oldEvent];
    d.candidates = [oldCandidate];
    state = advanceNarration(state, structuredClone(d), "alive", NOW + 2000);
    expect(state.entries).toBe(entries);
    expect(state.retiredEventThrough).toBeGreaterThan(NOW + 1);
    expect(state.retiredCandidateThrough).toBeGreaterThan(NOW + 1);
    d.events = [apiEvent(NOW + 2001, "new-api")];
    d.candidates = [
      candidate({
        id: "new-fill",
        createdAt: NOW + 2001,
        timestamp: NOW + 2001,
      }),
    ];
    state = advanceNarration(state, d, "alive", NOW + 2001);
    expect(state.entries.slice(-2).map((entry) => entry.kind)).toEqual([
      "warning",
      "trade",
    ]);
    expect(state.entries).toHaveLength(30);
    expect(state.seen.length).toBeLessThanOrEqual(200);
  });

  it("allows a known pending candidate to finish after its key was evicted", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const pending = candidate({
      id: "long-pending",
      createdAt: NOW,
      timestamp: NOW,
      finalAction: "PENDING",
    });
    d.candidates = [pending];
    let state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    for (let i = 1; i <= 300; i++) {
      d.candidates = [
        candidate({
          id: `later-${i}`,
          createdAt: NOW + i,
          timestamp: NOW + i,
          quotePriceUsdc: String(i),
        }),
      ];
      d.events = [apiEvent(NOW + i, `API${i}`)];
      state = advanceNarration(state, d, "alive", NOW + i);
    }
    expect(state.seen.some((key) => key.includes("long-pending"))).toBe(false);
    expect(state.pendingCandidateIds).toContain("long-pending");
    d.candidates = [{ ...pending, finalAction: "SELL" }];
    d.events = [];
    state = advanceNarration(state, d, "alive", NOW + 500);
    expect(state.entries.at(-1)?.text).toContain("売りを記録");
    expect(state.pendingCandidateIds).not.toContain("long-pending");
    expect(advanceNarration(state, d, "alive", NOW + 501).entries).toBe(
      state.entries,
    );
    expect(state.pendingCandidateIds.length).toBeLessThanOrEqual(50);
  });

  it("does not merge failures from different APIs at the same timestamp", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    d.events = [apiEvent(NOW, "DeepBook"), apiEvent(NOW, "Sui gRPC")];
    expect(
      advanceNarration(state, d, "alive", NOW).entries.filter(
        (e) => e.kind === "warning",
      ),
    ).toHaveLength(2);
  });

  it("no decision telemetry means no cycle narration", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, null);
    expect(d.decision).toBeNull();
    let state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].kind).toBe("status");
    const d2 = runningSnapshot(db, monitor, null);
    state = advanceNarration(state, d2, "alive", NOW);
    expect(state.entries).toHaveLength(1);
  });

  it("a decision recorded while stopped is not narrated as a live cycle", () => {
    const { db, monitor } = fixture();
    const d1 = monitor.snapshot(NOW);
    let state: NarrationState = advanceNarration(
      emptyNarrationState(),
      d1,
      "sleeping",
      NOW,
    );
    const count = state.entries.length;
    db.set("decision", decision({ evaluatedAt: NOW }));
    const d2 = monitor.snapshot(NOW);
    state = advanceNarration(state, d2, "sleeping", NOW);
    expect(state.entries.length).toBe(count);
  });
});

describe("narration tone: reasons, softly and shortly", () => {
  function telemetry(
    overrides: Omit<Partial<DecisionTelemetry>, "conditions"> & {
      conditions?: Partial<DecisionTelemetry["conditions"]>;
    } = {},
  ): DecisionTelemetry {
    const { conditions, ...rest } = overrides;
    return {
      evaluatedAt: NOW - 60_000,
      candleTimestamp: NOW - 300_000,
      action: "WAIT",
      reason: "",
      selectedRule: "NO_SIGNAL",
      sellPurpose: null,
      price: 2.4,
      entryPrice: null,
      ema20: 2.38,
      ema50: 2.42,
      rsi: 44,
      previousRsi: 42,
      histogram: -0.003,
      previousHistogram: -0.002,
      atr: 0.02,
      volumeChange: 0.05,
      oversold: 30,
      overbought: 70,
      stopLossPct: 0.02,
      takeProfitPct: 0.03,
      rsiLinePrice: null,
      ...rest,
      conditions: {
        emaUp: false,
        emaGapShrinking: false,
        rsiRecovery: false,
        histogramImproving: false,
        hasPosition: false,
        stopLoss: false,
        takeProfit: false,
        ...(conditions ?? {}),
      },
    };
  }

  const farWait = telemetry();
  const newlyMet = telemetry({
    previousRsi: 28,
    rsi: 34,
    conditions: { rsiRecovery: true },
  });
  const progress = telemetry({
    ema20: 2.43,
    ema50: 2.42,
    conditions: { emaUp: true },
  });
  const oneRemaining = telemetry({
    ema20: 2.43,
    ema50: 2.42,
    previousRsi: 28,
    rsi: 34,
    histogram: -0.0004,
    previousHistogram: -0.0002,
    conditions: { emaUp: true, rsiRecovery: true },
  });
  const brokeBefore = telemetry({
    histogram: -0.001,
    previousHistogram: -0.002,
    conditions: { histogramImproving: true },
  });
  const brokeNow = telemetry({
    histogram: -0.003,
    previousHistogram: -0.001,
  });
  const buyAll = telemetry({
    action: "BUY",
    selectedRule: "BUY_SIGNAL",
    ema20: 2.431,
    ema50: 2.424,
    previousRsi: 28,
    rsi: 39,
    histogram: 0.0009,
    previousHistogram: -0.001,
    conditions: {
      emaUp: true,
      emaGapShrinking: false,
      rsiRecovery: true,
      histogramImproving: true,
    },
  });
  const holding = telemetry({
    price: 2.35,
    entryPrice: 2.3,
    conditions: { hasPosition: true },
  });
  const sellNoEntry = telemetry({
    action: "SELL",
    sellPurpose: "TAKE_PROFIT",
    price: 2.4,
    entryPrice: null,
  });
  const volumeReject = telemetry({
    selectedRule: "VOLUME_REJECT",
    volumeChange: 3.5,
  });

  const scenarios: [string, string][] = [
    ["far WAIT", cycleNarrationText(farWait, null)],
    ["newly met", cycleNarrationText(newlyMet, decisionTrail(farWait))],
    ["progress", cycleNarrationText(progress, null)],
    ["one remaining", cycleNarrationText(oneRemaining, null)],
    ["regression", cycleNarrationText(brokeNow, decisionTrail(brokeBefore))],
    ["buy summary", cycleNarrationText(buyAll, null)],
    ["holding", cycleNarrationText(holding, null)],
    ["sell without entry", cycleNarrationText(sellNoEntry, null)],
    ["volume reject", cycleNarrationText(volumeReject, null)],
  ];

  it.each(scenarios)("%s stays within two short sentences", (_name, text) => {
    const sentences = text.split("。").filter((s) => s.length > 0);
    expect(sentences.length).toBeLessThanOrEqual(3);
    expect(text.length).toBeLessThanOrEqual(80);
  });

  it.each(scenarios)("%s avoids report-style phrasing", (_name, text) => {
    expect(text).not.toMatch(/です|ます|ました|確認できました|総括/);
  });

  it("a far WAIT still carries a recorded number", () => {
    const text = cycleNarrationText(farWait, null);
    expect(text).toMatch(/\d/);
    expect(text).toContain("EMAの差は-1.6667%");
  });

  it("a WAIT whose furthest condition approached says so", () => {
    // Same evidence twice: the furthest condition (EMA) did not move.
    const still = cycleNarrationText(farWait, decisionTrail(farWait));
    expect(still).toContain("まだ遠いなあ");
    // EMA gap narrowed since the previous cycle: an approach.
    const before = telemetry({ ema20: 2.3, ema50: 2.42 });
    const approached = cycleNarrationText(
      telemetry({ ema20: 2.36, ema50: 2.42 }),
      decisionTrail(before),
    );
    expect(approached).toContain("EMAの差は-2.5%");
    expect(approached).toContain("少し近づいてきたね");
  });

  it("2/3 met names the single missing condition", () => {
    const text = cycleNarrationText(oneRemaining, null);
    expect(text).toContain("あとMACDだけ");
    expect(text).toContain("-0.0004、ほぼゼロ");
  });

  it("a broken condition narrates the step back with its number", () => {
    const text = cycleNarrationText(brokeNow, decisionTrail(brokeBefore));
    expect(text).toContain("MACDが崩れて-0.003");
    expect(text).toContain("一歩さがったなあ");
  });

  it("a newly met condition is announced with the crossing numbers", () => {
    const text = cycleNarrationText(newlyMet, decisionTrail(farWait));
    expect(text).toContain("RSIが28→34で上抜けた");
    expect(text).toContain("残りはEMAとMACD");
  });

  it("a BUY narrates the summary of why, from the evidence", () => {
    const text = cycleNarrationText(buyAll, null);
    expect(text).toContain("3つ揃ったよ");
    expect(text).toContain("EMAは順並び");
    expect(text).toContain("RSIは28→39まで回復");
    expect(text).toContain("MACDもプラス");
    expect(text).toContain("だから買うね");
  });

  it("a shrink-route BUY does not claim the EMAs are aligned", () => {
    const text = cycleNarrationText(
      telemetry({
        action: "BUY",
        selectedRule: "BUY_SIGNAL",
        ema20: 2.418,
        ema50: 2.424,
        previousRsi: 28,
        rsi: 39,
        histogram: 0.0009,
        previousHistogram: -0.001,
        conditions: {
          emaUp: true,
          emaGapShrinking: true,
          rsiRecovery: true,
          histogramImproving: true,
        },
      }),
      null,
    );
    expect(text).toContain("3つ揃ったよ");
    expect(text).toContain("EMAは差が縮み続けて成立扱い");
    expect(text).not.toContain("EMAは順並び");
  });

  it("a newly met EMA via the shrink route is announced as such", () => {
    const text = cycleNarrationText(
      telemetry({
        ema20: 2.41,
        ema50: 2.42,
        conditions: { emaUp: true, emaGapShrinking: true },
      }),
      decisionTrail(farWait),
    );
    expect(text).toContain("EMAの差が縮み続けて成立扱いになった");
    expect(text).not.toContain("EMAが順並びになった");
  });

  it("a broken shrink-route EMA narrates the shrink stopping", () => {
    const before = telemetry({
      conditions: { emaUp: true, emaGapShrinking: true },
    });
    const text = cycleNarrationText(farWait, decisionTrail(before));
    expect(text).toContain("EMAの差の縮小が止まった");
    expect(text).not.toContain("EMAの並びが崩れた");
  });

  it("a position watch counts down to the take-profit line", () => {
    const text = cycleNarrationText(holding, null);
    expect(text).toContain("保有中だよ");
    expect(text).toContain("今は+2.1739%");
    expect(text).toContain("利確まであと0.8261%");
  });

  it("missing entry price is not invented for a SELL", () => {
    const text = cycleNarrationText(sellNoEntry, null);
    expect(text).toContain("利確のラインに触れたよ");
    expect(text).toContain("価格は2.4 USDCだね");
    expect(text).not.toContain("取得から");
    expect(text).not.toMatch(/NaN|undefined/);
  });

  it("a BUY without all conditions recorded does not claim a summary", () => {
    const text = cycleNarrationText(
      telemetry({ action: "BUY", selectedRule: "BUY_SIGNAL" }),
      null,
    );
    expect(text).toContain("買いシグナルが出たよ");
    expect(text).not.toContain("3つ揃ったよ");
  });
});

describe("agent narration: watch declaration", () => {
  /** Feed a sequence of recorded decisions through the narration. */
  function feed(decisions: (TradingDecision | null)[]) {
    const { db, monitor } = fixture();
    let state = emptyNarrationState();
    for (const dec of decisions) {
      const d = runningSnapshot(db, monitor, dec);
      state = advanceNarration(state, d, "alive", NOW);
    }
    return state;
  }
  const texts = (state: NarrationState) => state.entries.map((e) => e.text);
  const count = (state: NarrationState, part: string) =>
    texts(state).filter((t) => t.includes(part)).length;

  it("selects the closest unmet condition as the watch target", () => {
    // Defaults: MACD is closest (histogram nearly done improving).
    expect(feed([decision({})]).watch?.key).toBe("histogramImproving");
    // RSI two points above the line beats a MACD still far away.
    expect(
      feed([
        decision({ rsi: 32, histogram: -0.006, previousHistogram: -0.003 }),
      ]).watch?.key,
    ).toBe("rsiRecovery");
    // A nearly-closed EMA gap beats both when MACD is far (falling).
    expect(
      feed([
        decision({
          ema20: 2.415,
          ema50: 2.42,
          histogram: -0.008,
          previousHistogram: -0.001,
        }),
      ]).watch?.key,
    ).toBe("emaUp");
  });

  it("the first watch is set silently, with no declaration entry", () => {
    const state = feed([decision({})]);
    expect(state.watch?.key).toBe("histogramImproving");
    expect(state.entries).toHaveLength(1);
    expect(count(state, "見てる")).toBe(0);
  });

  it("declares once when a watch appears, and not again while it lasts", () => {
    const holding = decision({
      conditions: { hasPosition: true },
      entryPrice: 2.3,
      price: 2.35,
    });
    const state = feed([
      holding,
      decision({ evaluatedAt: NOW - 50_000 }),
      decision({ evaluatedAt: NOW - 40_000 }),
    ]);
    expect(
      count(state, "次はMACDを見てる。今-0.003、プラスに転じたら声かけるね"),
    ).toBe(1);
    expect(state.watch?.key).toBe("histogramImproving");
  });

  it("calls out the approach once per declaration, at half the distance", () => {
    const state = feed([
      decision({}),
      decision({ evaluatedAt: NOW - 50_000, histogram: -0.0014 }),
      decision({ evaluatedAt: NOW - 40_000, histogram: -0.0012 }),
    ]);
    expect(
      count(state, "MACD、-0.0014まで戻った。宣言してたやつ、来てるよ"),
    ).toBe(1);
    expect(count(state, "来てるよ")).toBe(1);
    expect(state.watch?.called).toBe(true);
  });

  it("a hit ties back to the declaration and declares the next watch", () => {
    const state = feed([
      decision({}),
      decision({
        evaluatedAt: NOW - 50_000,
        conditions: { histogramImproving: true },
        histogram: -0.001,
        previousHistogram: -0.002,
      }),
    ]);
    const all = texts(state);
    const hit = all.findIndex((t) => t.includes("言うてたやろ"));
    const next = all.findIndex((t) => t.includes("次の注目はRSIに決めた"));
    expect(all[hit]).toContain("MACD、成立した。今-0.001");
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(next).toBeGreaterThan(hit);
    expect(state.watch?.key).toBe("rsiRecovery");
    expect(state.watch?.called).toBe(false);
    // The hit is its own entry kind, and it timestamps the pose link.
    const hitEntry = state.entries.find((e) => e.kind === "watchHit");
    expect(hitEntry?.text).toBe(
      "MACD、成立した。今-0.001。ほらな、言うてたやろ",
    );
    expect(state.lastHitAt).toBe(NOW - 50_000);
  });

  it("a watch hit via the shrink route says the gap shrank, not that EMA20 crossed above", () => {
    const state = feed([
      decision({
        ema20: 2.415,
        ema50: 2.42,
        histogram: -0.008,
        previousHistogram: -0.001,
      }),
      decision({
        evaluatedAt: NOW - 50_000,
        ema20: 2.418,
        ema50: 2.42,
        conditions: { emaUp: true, emaGapShrinking: true },
      }),
    ]);
    const all = texts(state);
    expect(all.some((t) => t.includes("差の縮小が続いての成立"))).toBe(true);
    expect(all.some((t) => t.includes("の上。ほらな"))).toBe(false);
    expect(state.watch?.key).not.toBe("emaUp");
  });

  it("withdraws a drifted watch and switches to the next candidate", () => {
    const state = feed([
      decision({ rsi: 31 }),
      decision({ evaluatedAt: NOW - 50_000, rsi: 32 }),
    ]);
    expect(count(state, "注目してたRSI、遠のいたなあ。宣言は取り下げ")).toBe(1);
    expect(count(state, "注目はMACDに切り替える。今-0.003だよ")).toBe(1);
    expect(state.watch?.key).toBe("histogramImproving");
  });

  it("a called RSI watch that slips away is a near miss, still scored a miss", () => {
    const far = {
      ema20: 2.3,
      ema50: 2.42,
      histogram: -0.008,
      previousHistogram: -0.001,
    };
    const state = feed([
      decision({ ...far, rsi: 35 }),
      // Distance 2 of the declared 5: the approach is called here.
      decision({ ...far, evaluatedAt: NOW - 50_000, rsi: 32 }),
      // Distance 7: ratio 1.4, beyond the withdrawal hysteresis.
      decision({ ...far, evaluatedAt: NOW - 40_000, rsi: 37 }),
    ]);
    const nearMiss = state.entries.filter((e) => e.kind === "nearMiss");
    expect(nearMiss).toHaveLength(1);
    expect(nearMiss[0].text).toBe(
      "RSI、あと2まで来てたのに…なんで離れるねん",
    );
    expect(count(state, "宣言は取り下げ")).toBe(0);
    expect(state.watchScore.misses).toBe(1);
  });

  it("a called MACD watch that slips away names its closest histogram", () => {
    const state = feed([
      decision({}),
      decision({ evaluatedAt: NOW - 50_000, histogram: -0.0014 }),
      decision({ evaluatedAt: NOW - 40_000, histogram: -0.006 }),
    ]);
    const nearMiss = state.entries.filter((e) => e.kind === "nearMiss");
    expect(nearMiss).toHaveLength(1);
    expect(nearMiss[0].text).toBe(
      "MACD、-0.0014まで戻してたのに、また下がってもうたわ…",
    );
    expect(state.watchScore.misses).toBe(1);
  });

  it("hysteresis: a small wobble past the declared distance keeps the watch", () => {
    const far = {
      ema20: 2.3,
      ema50: 2.42,
      histogram: -0.008,
      previousHistogram: -0.001,
    };
    const state = feed([
      decision({ ...far, rsi: 35 }),
      // Distance 5 -> 6 points: ratio 1.2, inside the 1.25 hysteresis.
      decision({ ...far, evaluatedAt: NOW - 50_000, rsi: 36 }),
    ]);
    expect(state.watch?.key).toBe("rsiRecovery");
    expect(count(state, "取り下げ")).toBe(0);
    // Distance 7 points: ratio 1.4, clearly beyond — withdrawn.
    const drifted = feed([
      decision({ ...far, rsi: 35 }),
      decision({ ...far, evaluatedAt: NOW - 50_000, rsi: 36 }),
      decision({ ...far, evaluatedAt: NOW - 40_000, rsi: 37 }),
    ]);
    expect(count(drifted, "注目してたRSI、遠のいたなあ。宣言は取り下げ")).toBe(
      1,
    );
    expect(drifted.watch?.key).toBe("histogramImproving");
  });

  it("never declares without material, while holding, or when all met", () => {
    expect(feed([null]).watch).toBeNull();
    expect(
      feed([
        decision({
          conditions: { hasPosition: true },
          entryPrice: 2.3,
          price: 2.35,
        }),
      ]).watch,
    ).toBeNull();
    expect(
      feed([
        decision({
          conditions: {
            emaUp: true,
            emaGapShrinking: false,
            rsiRecovery: true,
            histogramImproving: true,
          },
          ema20: 2.43,
          ema50: 2.42,
          rsi: 39,
          previousRsi: 28,
          histogram: 0.001,
          previousHistogram: -0.001,
        }),
      ]).watch,
    ).toBeNull();
    expect(
      feed([decision({ action: "BUY", selectedRule: "BUY_SIGNAL" })]).watch,
    ).toBeNull();
  });

  it("a watch ends silently when a position opens", () => {
    const state = feed([
      decision({}),
      decision({
        evaluatedAt: NOW - 50_000,
        conditions: { hasPosition: true },
        entryPrice: 2.3,
        price: 2.35,
      }),
    ]);
    expect(state.watch).toBeNull();
    expect(count(state, "取り下げ")).toBe(0);
  });

  it("watch narration keeps the approved tone: short, soft, no report style", () => {
    const state = feed([
      decision({
        conditions: { hasPosition: true },
        entryPrice: 2.3,
        price: 2.35,
      }),
      // Declare EMA (closest here), then let it click.
      decision({
        evaluatedAt: NOW - 50_000,
        ema20: 2.415,
        ema50: 2.42,
        histogram: -0.008,
        previousHistogram: -0.001,
      }),
      decision({
        evaluatedAt: NOW - 40_000,
        ema20: 2.43,
        ema50: 2.42,
        conditions: { emaUp: true },
        histogram: -0.0014,
        previousHistogram: -0.003,
      }),
    ]);
    const watchLines = texts(state).filter((t) =>
      /注目|宣言|見てる|切り替える|決めた|言うてたやろ/.test(t),
    );
    expect(watchLines.length).toBeGreaterThanOrEqual(3);
    for (const line of watchLines) {
      const sentences = line.split("。").filter((s) => s.length > 0);
      expect(sentences.length).toBeLessThanOrEqual(3);
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(/です|ます|ました|確認できました|総括/);
      expect(line).toMatch(/\d/);
    }
  });

  it("currentWatch shows the target, its value and the change since declaration", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor, decision({}));
    const state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const shown = currentWatch(state, d1.decision, "alive", NOW);
    expect(shown).toMatchObject({
      key: "histogramImproving",
      label: "MACD",
      value: "今-0.003",
      detail: "宣言したところ。プラス転換待ち",
    });
    const d2 = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW - 50_000, histogram: -0.0014 }),
    );
    const approached = advanceNarration(state, d2, "alive", NOW);
    expect(currentWatch(approached, d2.decision, "alive", NOW)).toMatchObject({
      key: "histogramImproving",
      value: "今-0.0014",
      detail: "宣言時の半分以下。来てる",
    });
  });

  it("currentWatch explains why there is no watch, and hides without material", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(currentWatch(state, null, "alive", NOW)).toBeNull();
    expect(currentWatch(state, d.decision, "sleeping", NOW)).toMatchObject({
      key: null,
      label: "なし",
      detail: "止まってるから注目はお休み",
    });
    const holding = runningSnapshot(
      db,
      monitor,
      decision({
        evaluatedAt: NOW - 50_000,
        conditions: { hasPosition: true },
        entryPrice: 2.3,
        price: 2.35,
      }),
    );
    expect(currentWatch(state, holding.decision, "alive", NOW)).toMatchObject({
      key: null,
      detail: "保有中。条件が崩れたら声かける",
    });
    const allMet = runningSnapshot(
      db,
      monitor,
      decision({
        evaluatedAt: NOW - 40_000,
        conditions: {
          emaUp: true,
          emaGapShrinking: false,
          rsiRecovery: true,
          histogramImproving: true,
        },
        ema20: 2.43,
        ema50: 2.42,
        rsi: 39,
        previousRsi: 28,
        histogram: 0.001,
        previousHistogram: -0.001,
      }),
    );
    expect(currentWatch(state, allMet.decision, "alive", NOW)).toMatchObject({
      key: null,
      detail: "3つ揃ったので注目は終了",
    });
  });

  it("the watched condition's chip carries the marker", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    const chips = currentConditionChips(state, d.decision, NOW)!;
    expect(chips.find((c) => c.key === "macd")?.watching).toBe(true);
    expect(chips.find((c) => c.key === "ema")?.watching).toBe(false);
    expect(chips.find((c) => c.key === "rsi")?.watching).toBe(false);
  });
});

describe("buy-condition chips", () => {
  function telemetry(
    overrides: Omit<Partial<DecisionTelemetry>, "conditions"> & {
      conditions?: Partial<DecisionTelemetry["conditions"]>;
    } = {},
  ): DecisionTelemetry {
    const { conditions, ...rest } = overrides;
    return {
      evaluatedAt: NOW - 60_000,
      candleTimestamp: NOW - 300_000,
      action: "WAIT",
      reason: "",
      selectedRule: "NO_SIGNAL",
      sellPurpose: null,
      price: 2.4,
      entryPrice: null,
      ema20: 2.38,
      ema50: 2.42,
      rsi: 44,
      previousRsi: 42,
      histogram: -0.003,
      previousHistogram: -0.002,
      atr: 0.02,
      volumeChange: 0.05,
      oversold: 30,
      overbought: 70,
      stopLossPct: 0.02,
      takeProfitPct: 0.03,
      rsiLinePrice: null,
      ...rest,
      conditions: {
        emaUp: false,
        emaGapShrinking: false,
        rsiRecovery: false,
        histogramImproving: false,
        hasPosition: false,
        stopLoss: false,
        takeProfit: false,
        ...(conditions ?? {}),
      },
    };
  }
  const byKey = (chips: ReturnType<typeof entryConditionChips>) =>
    Object.fromEntries(chips.map((c) => [c.key, c]));

  it("all three met shows checkmarks", () => {
    const chips = entryConditionChips(
      telemetry({
        conditions: {
          emaUp: true,
          emaGapShrinking: false,
          rsiRecovery: true,
          histogramImproving: true,
        },
      }),
      null,
    );
    expect(chips.map((c) => c.status)).toEqual(["✓", "✓", "✓"]);
    expect(chips.every((c) => c.tone === "met")).toBe(true);
  });

  it("far conditions use the prototype's status words", () => {
    const chips = byKey(entryConditionChips(telemetry(), null));
    expect(chips.ema.status).toBe("逆並び");
    expect(chips.rsi.status).toBe("あと14");
    expect(chips.rsi.tone).toBe("far");
    expect(chips.macd.status).toBe("マイナス");
  });

  it("RSI points to the line are whole points from the evidence", () => {
    const chips = byKey(entryConditionChips(telemetry({ rsi: 41 }), null));
    expect(chips.rsi.status).toBe("あと11");
  });

  it("only the RSI distance survives as visible chip detail", () => {
    const chips = byKey(entryConditionChips(telemetry(), null));
    expect(chips.rsi.detail).toBe("あと14");
    expect(chips.ema.detail).toBeUndefined();
    expect(chips.macd.detail).toBeUndefined();
    const inZone = byKey(
      entryConditionChips(telemetry({ rsi: 28, previousRsi: 33 }), null),
    );
    expect(inZone.rsi.detail).toBeUndefined();
    const met = byKey(
      entryConditionChips(
        telemetry({
          conditions: {
            emaUp: true,
            emaGapShrinking: false,
            rsiRecovery: true,
            histogramImproving: true,
          },
        }),
        null,
      ),
    );
    expect(met.rsi.detail).toBeUndefined();
  });

  it("RSI inside the oversold zone reads 圏内", () => {
    const chips = byKey(
      entryConditionChips(telemetry({ rsi: 28, previousRsi: 33 }), null),
    );
    expect(chips.rsi.status).toBe("圏内");
    expect(chips.rsi.tone).toBe("close");
  });

  it("a nearly-closed EMA gap reads あと少し", () => {
    const chips = byKey(
      entryConditionChips(telemetry({ ema20: 2.415, ema50: 2.42 }), null),
    );
    expect(chips.ema.status).toBe("あと少し");
  });

  it("a histogram a hair below zero reads あと1", () => {
    const chips = byKey(
      entryConditionChips(
        telemetry({ histogram: -0.0004, previousHistogram: -0.0002 }),
        null,
      ),
    );
    expect(chips.macd.status).toBe("あと1");
    expect(chips.macd.tone).toBe("close");
  });

  it("without an ATR the near-zero MACD status is not claimed", () => {
    const chips = byKey(
      entryConditionChips(
        telemetry({
          histogram: -0.0004,
          previousHistogram: -0.0002,
          atr: 0,
        }),
        null,
      ),
    );
    expect(chips.macd.status).toBe("マイナス");
  });

  it("conditions met last cycle and broken now read 後退", () => {
    const before = telemetry({
      conditions: {
        emaUp: true,
        emaGapShrinking: false,
        rsiRecovery: true,
        histogramImproving: true,
      },
    });
    const chips = byKey(
      entryConditionChips(telemetry(), decisionTrail(before)),
    );
    expect(chips.ema.status).toBe("後退");
    expect(chips.rsi.status).toBe("後退");
    expect(chips.macd.status).toBe("後退");
    expect(chips.macd.tone).toBe("back");
  });

  it("currentConditionChips is null without a fresh decision", () => {
    const state = emptyNarrationState();
    expect(currentConditionChips(state, null, NOW)).toBeNull();
    const stale = telemetry({ evaluatedAt: NOW - 360_001 });
    expect(currentConditionChips(state, stale, NOW)).toBeNull();
    const fresh = telemetry({ evaluatedAt: NOW - 1_000 });
    const chips = currentConditionChips(state, fresh, NOW);
    expect(chips).not.toBeNull();
    expect(chips!.map((c) => c.label)).toEqual(["EMA", "RSI", "MACD"]);
  });
});

describe("agent narration: watch score and review", () => {
  /** Feed a sequence of recorded decisions through the narration. */
  function feed(decisions: (TradingDecision | null)[]) {
    const { db, monitor } = fixture();
    let state = emptyNarrationState();
    for (const dec of decisions) {
      const d = runningSnapshot(db, monitor, dec);
      state = advanceNarration(state, d, "alive", NOW);
    }
    return state;
  }
  const reviews = (state: NarrationState) =>
    state.entries.filter((e) => e.kind === "review");
  const macdClicks = {
    conditions: { histogramImproving: true },
    histogram: -0.001,
    previousHistogram: -0.002,
  };

  it("scores a hit, and the follow-up declaration as a new one", () => {
    const state = feed([
      decision({}),
      decision({ evaluatedAt: NOW - 50_000, ...macdClicks }),
    ]);
    // The silent first watch counts as a declaration; the MACD hit
    // settles it, and the next watch (RSI) is a second declaration.
    expect(state.watchScore).toMatchObject({
      declared: 2,
      hits: 1,
      misses: 0,
      unreviewed: 1,
    });
    expect(state.watch?.key).toBe("rsiRecovery");
    expect(reviews(state)).toHaveLength(0);
  });

  it("scores a miss on withdrawal; the switch target is a new declaration", () => {
    const state = feed([
      decision({ rsi: 31 }),
      decision({ evaluatedAt: NOW - 50_000, rsi: 32 }),
    ]);
    expect(state.watchScore).toMatchObject({
      declared: 2,
      hits: 0,
      misses: 1,
      unreviewed: 1,
    });
    expect(state.watch?.key).toBe("histogramImproving");
  });

  it("a watch that ends silently is neither a hit nor a miss", () => {
    const state = feed([
      decision({}),
      decision({
        evaluatedAt: NOW - 50_000,
        conditions: { hasPosition: true },
        entryPrice: 2.3,
        price: 2.35,
      }),
    ]);
    expect(state.watch).toBeNull();
    expect(state.watchScore).toMatchObject({
      declared: 1,
      hits: 0,
      misses: 0,
      unreviewed: 0,
    });
  });

  it("the last condition clicking into a BUY still scores a hit", () => {
    const state = feed([
      decision({
        conditions: { emaUp: true, rsiRecovery: true },
        ema20: 2.43,
        ema50: 2.42,
        rsi: 39,
        previousRsi: 28,
        histogram: -0.001,
        previousHistogram: -0.002,
      }),
      decision({
        evaluatedAt: NOW - 50_000,
        action: "BUY",
        selectedRule: "BUY_SIGNAL",
        conditions: {
          emaUp: true,
          emaGapShrinking: false,
          rsiRecovery: true,
          histogramImproving: true,
        },
        ema20: 2.43,
        ema50: 2.42,
        rsi: 39,
        previousRsi: 28,
        histogram: 0.001,
        previousHistogram: -0.001,
      }),
    ]);
    expect(state.watchScore).toMatchObject({
      declared: 1,
      hits: 1,
      misses: 0,
      unreviewed: 1,
    });
    expect(state.watch).toBeNull();
    // One settlement is not enough for the BUY early review either.
    expect(reviews(state)).toHaveLength(0);
  });

  it("reviews once when three settlements pile up, then resets", () => {
    const settled = feed([
      decision({}),
      decision({ evaluatedAt: NOW - 55_000, ...macdClicks }),
      decision({
        evaluatedAt: NOW - 50_000,
        conditions: { histogramImproving: true, rsiRecovery: true },
        rsi: 36,
        previousRsi: 31,
        histogram: 0.0005,
        previousHistogram: -0.002,
      }),
      decision({
        evaluatedAt: NOW - 45_000,
        conditions: { rsiRecovery: true, histogramImproving: true },
        ema20: 2.3,
        ema50: 2.42,
        price: 2.45,
        histogram: 0.0005,
        previousHistogram: -0.002,
      }),
    ]);
    // Hit (MACD), hit (RSI), miss (EMA withdrawn): the third
    // settlement triggers exactly one look-back (two lines).
    expect(settled.watchScore).toMatchObject({
      declared: 3,
      hits: 2,
      misses: 1,
      unreviewed: 0,
    });
    const lines = reviews(settled);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe(
      "ふりかえり。ここまでの宣言は3回、的中2回、外れ1回。悪くないね",
    );
    expect(lines[1].text).toContain("価格は$2.4から$2.45");
    expect(lines[1].text).toContain("上がってきたね");
    // One more settlement after the reset does not re-review.
    const more = feed([
      decision({}),
      decision({ evaluatedAt: NOW - 55_000, ...macdClicks }),
      decision({
        evaluatedAt: NOW - 50_000,
        conditions: { histogramImproving: true, rsiRecovery: true },
        rsi: 36,
        previousRsi: 31,
        histogram: 0.0005,
        previousHistogram: -0.002,
      }),
      decision({
        evaluatedAt: NOW - 45_000,
        conditions: { rsiRecovery: true, histogramImproving: true },
        ema20: 2.3,
        ema50: 2.42,
        price: 2.45,
        histogram: 0.0005,
        previousHistogram: -0.002,
      }),
      decision({ evaluatedAt: NOW - 40_000 }),
      decision({ evaluatedAt: NOW - 35_000, ...macdClicks }),
    ]);
    expect(more.watchScore.unreviewed).toBe(1);
    expect(reviews(more)).toHaveLength(2);
  });

  it("a BUY milestone reviews early with two unreviewed settlements", () => {
    const state = feed([
      decision({}),
      decision({ evaluatedAt: NOW - 55_000, ...macdClicks }),
      decision({
        evaluatedAt: NOW - 50_000,
        conditions: { emaUp: true, histogramImproving: true },
        ema20: 2.43,
        ema50: 2.42,
        rsi: 50,
        previousRsi: 44,
        histogram: 0.0005,
        previousHistogram: -0.001,
      }),
      decision({
        evaluatedAt: NOW - 45_000,
        action: "BUY",
        selectedRule: "BUY_SIGNAL",
        conditions: {
          emaUp: true,
          emaGapShrinking: false,
          rsiRecovery: true,
          histogramImproving: true,
        },
        ema20: 2.43,
        ema50: 2.42,
        rsi: 39,
        previousRsi: 28,
        histogram: 0.001,
        previousHistogram: -0.001,
      }),
    ]);
    // Hit (MACD), miss (RSI withdrawn, no next watch), then the BUY
    // itself settles nothing — the milestone alone fires the review.
    expect(state.watchScore).toMatchObject({
      declared: 2,
      hits: 1,
      misses: 1,
      unreviewed: 0,
    });
    const lines = reviews(state);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe(
      "ふりかえり。ここまでの宣言は2回、的中1回、外れ1回。五分五分だね",
    );
    expect(lines[1].text).toContain("最後は3つ揃ったよ");
  });

  it("a BUY with only one unreviewed settlement does not review", () => {
    const state = feed([
      decision({}),
      decision({ evaluatedAt: NOW - 50_000, ...macdClicks }),
      decision({
        evaluatedAt: NOW - 45_000,
        action: "BUY",
        selectedRule: "BUY_SIGNAL",
        conditions: { histogramImproving: true },
        histogram: 0.001,
        previousHistogram: -0.001,
      }),
    ]);
    // The watched RSI never clicked in the BUY decision, so the BUY
    // settles nothing and one past settlement is below the minimum.
    expect(state.watchScore).toMatchObject({ hits: 1, unreviewed: 1 });
    expect(reviews(state)).toHaveLength(0);
  });

  it("currentWatchScore mirrors the record and hides without fresh material", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor, decision({}));
    const state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    expect(currentWatchScore(state, d1.decision, NOW)).toEqual({
      declared: 1,
      hits: 0,
      misses: 0,
      inProgress: 1,
    });
    expect(currentWatchScore(state, null, NOW)).toBeNull();
    const stale = {
      ...d1.decision!,
      evaluatedAt: NOW - 400_000,
      candleTimestamp: NOW - 500_000,
    };
    expect(currentWatchScore(state, stale, NOW)).toBeNull();
  });

  it("review lines are built only from the recorded facts handed in", () => {
    const counts = reviewNarrationTexts(
      { declared: 4, hits: 3, misses: 1 },
      2.412,
      2.483,
      true,
    );
    expect(counts[0]).toBe(
      "ふりかえり。ここまでの宣言は4回、的中3回、外れ1回。悪くないね",
    );
    expect(counts).toHaveLength(2);
    expect(counts[1]).toContain("価格は$2.412から$2.483、+2.9%");
    expect(counts[1]).toContain("最後は3つ揃ったよ");
    // No recorded start (or current) price: the price line is
    // omitted entirely rather than invented.
    expect(
      reviewNarrationTexts(
        { declared: 4, hits: 3, misses: 1 },
        null,
        2.483,
        false,
      ),
    ).toHaveLength(1);
    expect(
      reviewNarrationTexts(
        { declared: 4, hits: 3, misses: 1 },
        2.412,
        null,
        false,
      ),
    ).toHaveLength(1);
    expect(
      reviewNarrationTexts(
        { declared: 4, hits: 3, misses: 1 },
        0,
        2.483,
        false,
      ),
    ).toHaveLength(1);
    // The verdict follows the recorded balance only.
    expect(
      reviewNarrationTexts(
        { declared: 3, hits: 0, misses: 2 },
        null,
        null,
        false,
      )[0],
    ).toContain("外れが多めだなあ");
    expect(
      reviewNarrationTexts(
        { declared: 2, hits: 1, misses: 1 },
        null,
        null,
        false,
      )[0],
    ).toContain("五分五分だね");
  });

  it("review narration keeps the approved tone: short, soft, no report style", () => {
    const lines = reviewNarrationTexts(
      { declared: 4, hits: 3, misses: 1 },
      2.412,
      2.483,
      true,
    );
    for (const line of lines) {
      const sentences = line.split("。").filter((s) => s.length > 0);
      expect(sentences.length).toBeLessThanOrEqual(3);
      expect(line.length).toBeLessThanOrEqual(80);
      expect(line).not.toMatch(/です|ます|ました|確認できました|総括/);
      expect(line).toMatch(/\d/);
    }
  });
});

describe("agent narration: spike alerts", () => {
  type DecisionOverrides = Parameters<typeof decision>[0];
  /** A decision sequence with strictly increasing evaluatedAt,
   * the last one at NOW, so every step is a fresh narrated cycle
   * (the first one initialises the feed). */
  const seq = (list: DecisionOverrides[]) =>
    list.map((o, i) =>
      decision({
        ...o,
        evaluatedAt: NOW - (list.length - 1 - i) * 10_000,
      }),
    );

  function feedRun(
    decisions: (TradingDecision | null)[],
    vital: "alive" | "sleeping" = "alive",
  ) {
    const { db, monitor } = fixture();
    let state = emptyNarrationState();
    let last = runningSnapshot(db, monitor, null);
    for (const dec of decisions) {
      last = runningSnapshot(db, monitor, dec);
      state = advanceNarration(state, last, vital, NOW);
    }
    return { state, last };
  }
  const feed = (decisions: (TradingDecision | null)[]) =>
    feedRun(decisions).state;
  const alertsOf = (state: NarrationState) =>
    state.entries.filter((e) => e.kind === "alert");

  function telemetry(
    overrides: Omit<Partial<DecisionTelemetry>, "conditions"> & {
      conditions?: Partial<DecisionTelemetry["conditions"]>;
    } = {},
  ): DecisionTelemetry {
    const { conditions, ...rest } = overrides;
    return {
      evaluatedAt: NOW - 60_000,
      candleTimestamp: NOW - 300_000,
      action: "WAIT",
      reason: "",
      selectedRule: "NO_SIGNAL",
      sellPurpose: null,
      price: 2.4,
      entryPrice: null,
      ema20: 2.38,
      ema50: 2.42,
      rsi: 44,
      previousRsi: 42,
      histogram: -0.003,
      previousHistogram: -0.002,
      atr: 0.02,
      volumeChange: 0.05,
      oversold: 30,
      overbought: 70,
      stopLossPct: 0.02,
      takeProfitPct: 0.03,
      rsiLinePrice: null,
      ...rest,
      conditions: {
        emaUp: false,
        emaGapShrinking: false,
        rsiRecovery: false,
        histogramImproving: false,
        hasPosition: false,
        stopLoss: false,
        takeProfit: false,
        ...(conditions ?? {}),
      },
    };
  }
  const warmed = [2.4, 2.4, 2.4];

  it("stays silent during warm-up: fewer than four price points", () => {
    // Unit level: even a huge volume spike cannot alert yet.
    expect(spikeAlert([], telemetry({ volumeChange: 3.5 }))).toBeNull();
    expect(spikeAlert([2.4, 2.4], telemetry({ volumeChange: 3.5 }))).toBeNull();
    // Feed level: three recorded decisions are only three points.
    const state = feed(
      seq([
        { volumeChange: 3.5 },
        { volumeChange: 3.5 },
        { volumeChange: 3.5 },
      ]),
    );
    expect(alertsOf(state)).toHaveLength(0);
    expect(state.lastAlert).toBeNull();
  });

  it("alerts at exactly +1% against three cycles ago, and not below", () => {
    expect(alertsOf(feed(seq([{}, {}, {}, { price: 2.4216 }])))).toHaveLength(
      0,
    );
    const state = feed(seq([{}, {}, {}, { price: 2.424 }]));
    const alerts = alertsOf(state);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("+1.0%");
    // The alert follows the cycle's own narration in the same cycle.
    expect(state.entries.at(-1)?.kind).toBe("alert");
  });

  it("alerts at exactly -1% with the plunge wording", () => {
    expect(alertsOf(feed(seq([{}, {}, {}, { price: 2.3784 }])))).toHaveLength(
      0,
    );
    const alerts = alertsOf(feed(seq([{}, {}, {}, { price: 2.376 }])));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe("速報。SUI、-1.0%。急落だ。ちょっと様子見る");
  });

  it("a volume-only spike alerts on its own, at the +200% boundary", () => {
    expect(spikeAlert(warmed, telemetry({ volumeChange: 1.99 }))).toBeNull();
    const edge = spikeAlert(warmed, telemetry({ volumeChange: 2 }));
    expect(edge?.direction).toBe("volume");
    expect(edge?.text).toContain("+200%");
    const state = feed(seq([{}, {}, {}, { volumeChange: 2.5 }]));
    const alerts = alertsOf(state);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe(
      "速報。出来高の変化が+250%に跳ねた。何かあったかも",
    );
    expect(state.lastAlert?.direction).toBe("volume");
  });

  it("a huge volume spike alerts as a multiple, not an astronomical percent", () => {
    const huge = spikeAlert(warmed, telemetry({ volumeChange: 49 }));
    expect(huge?.direction).toBe("volume");
    expect(huge?.text).toBe("速報。出来高が約50倍に跳ねた。何かあったかも");
    // The switch matches the reject line: nine is the boundary.
    expect(spikeAlert(warmed, telemetry({ volumeChange: 9 }))?.text).toBe(
      "速報。出来高が約10倍に跳ねた。何かあったかも",
    );
    expect(spikeAlert(warmed, telemetry({ volumeChange: 8.9 }))?.text).toBe(
      "速報。出来高の変化が+890%に跳ねた。何かあったかも",
    );
  });

  it("merges a simultaneous price and volume spike into one entry", () => {
    const state = feed(seq([{}, {}, {}, { price: 2.4432, volumeChange: 3 }]));
    const alerts = alertsOf(state);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe(
      "速報。SUI、短時間で+1.8%。出来高の変化も跳ねた",
    );
    expect(state.lastAlert?.direction).toBe("up");
  });

  it("an upward price spike alone uses the short surge wording", () => {
    const alerts = alertsOf(feed(seq([{}, {}, {}, { price: 2.4432 }])));
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toBe("速報。SUI、短時間で+1.8%。急に来た");
  });

  it("a downward spike with a volume spike still mentions both, once", () => {
    const alerts = alertsOf(
      feed(seq([{}, {}, {}, { price: 2.3448, volumeChange: 3 }])),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("-2.3%");
    expect(alerts[0].text).toContain("出来高の変化も跳ねた");
    expect(alerts[0].text).toContain("急落だ");
  });

  it("cools down for five narrated cycles, then can fire again", () => {
    const spike = { volumeChange: 3 };
    const decisions = seq([
      {},
      {},
      {},
      spike, // 4th point: fires, cooldown starts
      spike,
      spike,
      spike,
      spike,
      spike, // five suppressed cycles
      { volumeChange: 2.5 }, // cooldown over: fires again
    ]);
    const during = feed(decisions.slice(0, 9));
    expect(alertsOf(during)).toHaveLength(1);
    const state = feed(decisions);
    const alerts = alertsOf(state);
    expect(alerts).toHaveLength(2);
    expect(alerts[0].text).toContain("+300%");
    expect(alerts[1].text).toContain("+250%");
    expect(state.alertCooldown).toBe(5);
  });

  it("never duplicates the volume story of a VOLUME_REJECT cycle", () => {
    const reject = {
      selectedRule: "VOLUME_REJECT",
      volumeChange: 3.5,
    };
    const quiet = feed(seq([{}, {}, {}, reject]));
    expect(alertsOf(quiet)).toHaveLength(0);
    // The cycle's own line already printed the volume change.
    expect(quiet.entries.some((e) => e.text.includes("変化は350%"))).toBe(true);
    // A price spike on a reject cycle still alerts — price only.
    const loud = feed(seq([{}, {}, {}, { ...reject, price: 2.4432 }]));
    const alerts = alertsOf(loud);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("+1.8%");
    expect(alerts[0].text).not.toContain("出来高");
  });

  it("alerts while holding a position (the plunge watch)", () => {
    const hold = {
      conditions: { hasPosition: true },
      entryPrice: 2.4,
    };
    const state = feed(
      seq([
        { ...hold, price: 2.4 },
        { ...hold, price: 2.4 },
        { ...hold, price: 2.4 },
        { ...hold, price: 2.3448 },
      ]),
    );
    const alerts = alertsOf(state);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("急落だ");
    expect(state.entries.some((e) => e.text.includes("保有中だよ"))).toBe(true);
  });

  it("does not alert while sleeping, and a re-fed snapshot adds nothing", () => {
    const decisions = seq([{}, {}, {}, { price: 2.4432 }]);
    const { db, monitor } = fixture();
    let state = emptyNarrationState();
    decisions.forEach((dec, i) => {
      const d = runningSnapshot(db, monitor, dec);
      state = advanceNarration(state, d, i < 3 ? "alive" : "sleeping", NOW);
    });
    expect(alertsOf(state)).toHaveLength(0);
    expect(state.lastAlert).toBeNull();

    const { state: fired, last } = feedRun(
      seq([{}, {}, {}, { price: 2.4432 }]),
    );
    expect(alertsOf(fired)).toHaveLength(1);
    const again = advanceNarration(fired, last, "alive", NOW);
    expect(again.entries).toBe(fired.entries);
    expect(alertsOf(again)).toHaveLength(1);
  });

  it("points on the upward alert cycle only; a plunge never points", () => {
    const up = feedRun(seq([{}, {}, {}, { price: 2.4432 }]));
    expect(alertsOf(up.state)).toHaveLength(1);
    const upVital = botVital(up.last, false, NOW, NOW);
    expect(upVital.state).toBe("alive");
    expect(agentPose(up.state, up.last, upVital, NOW)).toBe("point");

    // Same shape with no alert: fewer than two conditions met and
    // nothing else to celebrate, so the pose stays at the laptop.
    const calm = feedRun(seq([{}, {}, {}, { price: 2.41 }]));
    expect(alertsOf(calm.state)).toHaveLength(0);
    expect(
      agentPose(
        calm.state,
        calm.last,
        botVital(calm.last, false, NOW, NOW),
        NOW,
      ),
    ).toBe("laptop");

    const down = feedRun(seq([{}, {}, {}, { price: 2.3448 }]));
    expect(down.state.lastAlert?.direction).toBe("down");
    expect(
      agentPose(
        down.state,
        down.last,
        botVital(down.last, false, NOW, NOW),
        NOW,
      ),
    ).toBe("laptop");
  });

  it("spikeAlert fails closed on unusable evidence", () => {
    expect(spikeAlert(warmed, telemetry({ price: Number.NaN }))).toBeNull();
    expect(spikeAlert(warmed, telemetry({ price: 0 }))).toBeNull();
    expect(spikeAlert(warmed, telemetry({ price: -1 }))).toBeNull();
    expect(
      spikeAlert([Number.NaN, 2.4, 2.4], telemetry({ price: 2.4432 })),
    ).toBeNull();
    // A broken volume change cannot alert on its own, but a clean
    // price spike on the same cycle still can.
    expect(
      spikeAlert(warmed, telemetry({ volumeChange: Number.NaN })),
    ).toBeNull();
    expect(
      spikeAlert(warmed, telemetry({ volumeChange: Number.NaN, price: 2.4432 }))
        ?.direction,
    ).toBe("up");
  });

  it("alert texts keep the tone: short, one-decimal percents, no report style", () => {
    const samples = [
      spikeAlert(warmed, telemetry({ price: 2.4432 })),
      spikeAlert(warmed, telemetry({ price: 2.4432, volumeChange: 3 })),
      spikeAlert(warmed, telemetry({ price: 2.3448 })),
      spikeAlert(warmed, telemetry({ price: 2.3448, volumeChange: 3 })),
      spikeAlert(warmed, telemetry({ volumeChange: 2.5 })),
    ];
    for (const sample of samples) {
      expect(sample).not.toBeNull();
      const text = sample!.text;
      const sentences = text.split("。").filter((s) => s.length > 0);
      expect(sentences.length).toBeLessThanOrEqual(4);
      expect(text.length).toBeLessThanOrEqual(80);
      expect(text).not.toMatch(/です|ます|ました|確認できました|総括/);
      expect(text).not.toMatch(/\d\.\d{2,}%/);
      expect(text).toMatch(/\d/);
      expect(text.startsWith("速報。")).toBe(true);
    }
  });
});

describe("agent narration: sleep talk", () => {
  const talksOf = (state: NarrationState) =>
    state.entries.filter((e) => e.kind === "sleepTalk");

  it("mutters the session's near miss in its sleep, spaced out and never twice in a row", () => {
    const { db, monitor } = fixture();
    const far = {
      ema20: 2.3,
      ema50: 2.42,
      histogram: -0.008,
      previousHistogram: -0.001,
    };
    let state = emptyNarrationState();
    for (const dec of [
      decision({ ...far, rsi: 35 }),
      decision({ ...far, evaluatedAt: NOW - 50_000, rsi: 32 }),
      decision({ ...far, evaluatedAt: NOW - 40_000, rsi: 37 }),
    ]) {
      const d = runningSnapshot(db, monitor, dec);
      state = advanceNarration(state, d, "alive", NOW);
    }
    expect(state.lastNearMiss).toMatchObject({ key: "rsiRecovery" });

    const d = runningSnapshot(db, monitor, null);
    // The sleep begins: no mutter yet.
    state = advanceNarration(state, d, "sleeping", NOW);
    expect(talksOf(state)).toHaveLength(0);
    // A quarter hour in, the near miss surfaces as a mutter.
    state = advanceNarration(state, d, "sleeping", NOW + 16 * 60_000);
    expect(talksOf(state).map((e) => e.text)).toEqual([
      "RSIがあと2やったのに…むにゃ…",
    ]);
    // Too soon for another.
    state = advanceNarration(state, d, "sleeping", NOW + 20 * 60_000);
    expect(talksOf(state)).toHaveLength(1);
    // The next window brings a different mutter, never a repeat.
    state = advanceNarration(state, d, "sleeping", NOW + 32 * 60_000);
    expect(talksOf(state)).toHaveLength(2);
    expect(talksOf(state)[1].text).not.toBe(talksOf(state)[0].text);
  });

  it("never mutters on a safety stop (flatlined)", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, null);
    let state = advanceNarration(emptyNarrationState(), d, "flatlined", NOW);
    state = advanceNarration(state, d, "flatlined", NOW + 60 * 60_000);
    expect(talksOf(state)).toHaveLength(0);
  });

  it("dreams of SUI itself when the session left no facts", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, null);
    let state = advanceNarration(emptyNarrationState(), d, "sleeping", NOW);
    state = advanceNarration(state, d, "sleeping", NOW + 16 * 60_000);
    expect(talksOf(state).map((e) => e.text)).toEqual(["すい…すい…"]);
  });
});

describe("buy-run line narration", () => {
  function feed(decisions: (TradingDecision | null)[]) {
    const { db, monitor } = fixture();
    let state = emptyNarrationState();
    for (const dec of decisions) {
      const d = runningSnapshot(db, monitor, dec);
      state = advanceNarration(state, d, "alive", NOW);
    }
    return state;
  }
  const ofKind = (state: NarrationState, kind: string) =>
    state.entries.filter((e) => e.kind === kind);

  it("declares the line, murmurs once on approach, and marks the touch", () => {
    const state = feed([
      decision({ evaluatedAt: NOW - 55_000, price: 2.4 }),
      decision({ evaluatedAt: NOW - 50_000, price: 2.4, rsiLinePrice: 2.1 }),
      // (2.1 / 2.13 - 1) * 100 = -1.41% — inside the murmur range.
      decision({ evaluatedAt: NOW - 40_000, price: 2.13, rsiLinePrice: 2.1 }),
      // Still close: no second murmur.
      decision({ evaluatedAt: NOW - 30_000, price: 2.12, rsiLinePrice: 2.1 }),
      // Touch: the decision price reaches the line.
      decision({ evaluatedAt: NOW - 20_000, price: 2.09, rsiLinePrice: 2.1 }),
    ]);
    const declared = ofKind(state, "priceLine");
    expect(declared).toHaveLength(1);
    expect(declared[0].text).toBe(
      "宣言するよ。2.1 USDCまで下がったらRSIがラインに届く。反発したら買いに走る",
    );
    const murmurs = state.entries.filter((e) =>
      e.text.includes("じわじわ来てる"),
    );
    expect(murmurs).toHaveLength(1);
    expect(murmurs[0].text).toBe("ラインまで あと-1.4%。じわじわ来てる");
    const reached = ofKind(state, "priceLineReached");
    expect(reached).toHaveLength(1);
    expect(reached[0].text).toBe(
      "届いた！2.1 USDCタッチ。あとはRSIの反発待ち",
    );
    expect(state.priceLine?.reached).toBe(true);
  });

  it("withdraws the line when the setup breaks", () => {
    const state = feed([
      decision({ evaluatedAt: NOW - 55_000, price: 2.4 }),
      decision({ evaluatedAt: NOW - 50_000, price: 2.4, rsiLinePrice: 2.1 }),
      decision({ evaluatedAt: NOW - 40_000, price: 2.4, rsiLinePrice: null }),
    ]);
    expect(
      state.entries.filter((e) =>
        e.text.includes("買い走りラインは取り下げ。条件が崩れた"),
      ),
    ).toHaveLength(1);
    expect(state.priceLine).toBeNull();
  });

  it("a line already up when the feed opens is adopted silently", () => {
    const state = feed([
      decision({ evaluatedAt: NOW - 50_000, price: 2.4, rsiLinePrice: 2.1 }),
    ]);
    expect(ofKind(state, "priceLine")).toHaveLength(0);
    expect(state.priceLine?.price).toBe(2.1);
    expect(state.priceLine?.reached).toBe(false);
  });

  it("a BUY ends the line silently — the trade tells the story", () => {
    const state = feed([
      decision({ evaluatedAt: NOW - 55_000, price: 2.4 }),
      decision({ evaluatedAt: NOW - 50_000, price: 2.4, rsiLinePrice: 2.1 }),
      decision({
        evaluatedAt: NOW - 40_000,
        price: 2.2,
        rsiLinePrice: null,
        action: "BUY",
        selectedRule: "BUY_SIGNAL",
      }),
    ]);
    expect(
      state.entries.filter((e) => e.text.includes("取り下げ")),
    ).toHaveLength(0);
    expect(state.priceLine).toBeNull();
  });
});
