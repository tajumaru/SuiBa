import { describe, expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { botVital } from "../apps/dashboard/src/botVital.ts";
import {
  advanceNarration,
  agentPose,
  cycleNarrationText,
  emptyNarrationState,
  MAX_NARRATION_ENTRIES,
  type NarrationState,
} from "../apps/dashboard/src/agentNarration.ts";
import type { TradingDecision } from "../packages/shared/src/index.ts";
import type {
  CandidateAudit,
  OperationEvent,
} from "../packages/shared/src/operations.ts";
import type { ApiFailure } from "../packages/shared/src/http-errors.ts";

const NOW = 1_800_000_000_000;

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
      candleTimestamp: NOW - 300_000,
      previousCandleTimestamp: NOW - 600_000,
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
    },
  };
}

function fixture() {
  const db = new BotDatabase(":memory:");
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

function apiEvent(at: number, api: string, code = "UPSTREAM_HTTP_503"): OperationEvent {
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
    expect(state.entries[0].text).toContain("停止中です");
    const vital = botVital(d, false, NOW, NOW);
    expect(agentPose(state, d, vital)).toBe("sleep");
  });

  it("a running bot narrates its latest recorded cycle with real numbers", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].kind).toBe("cycle");
    expect(state.entries[0].text).toContain("買い条件は0/3");
    expect(state.entries[0].text).toContain("EMA20（2.38）がEMA50（2.42）");
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

  it("a new cycle with 2/3 conditions met narrates progress and points", () => {
    const { state, d2 } = twoCycles();
    expect(state.entries).toHaveLength(2);
    expect(state.entries[1].text).toContain("買い条件が2/3そろってきました");
    const vital = botVital(d2, false, NOW, NOW);
    expect(agentPose(state, d2, vital)).toBe("point");
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
        ema20: 2.418,
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
        conditions: {
          emaUp: false,
          rsiRecovery: false,
          histogramImproving: true,
          hasPosition: false,
          stopLoss: false,
          takeProfit: false,
        },
      },
      null,
    );
    expect(text).toContain("買い条件が1/3そろってきました");
    expect(text).toContain("売られすぎライン（30）の下");
    expect(text).toContain("反発の起点待ち");
  });

  it("identical consecutive cycle evidence is not narrated twice", () => {
    const { db, monitor } = fixture();
    const d1 = runningSnapshot(db, monitor, decision({}));
    let state = advanceNarration(emptyNarrationState(), d1, "alive", NOW);
    const d2 = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW }),
    );
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
        conditions: {
          emaUp: true,
          rsiRecovery: false,
          histogramImproving: false,
          hasPosition: true,
          stopLoss: false,
          takeProfit: false,
        },
      },
      null,
    );
    expect(text).toContain("保有中です");
    expect(text).toContain("取得価格2.3 USDCに対して現在2.4 USDC");
    expect(text).toContain("+4.3478%");
  });

  it("a volume rejection narrates the measured volume change", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(
      db,
      monitor,
      decision({ selectedRule: "VOLUME_REJECT", volumeChange: 3.5 }),
    );
    const state = advanceNarration(emptyNarrationState(), d, "alive", NOW);
    expect(state.entries[0].text).toContain("出来高の異常を検出したため見送りました");
    expect(state.entries[0].text).toContain("350%");
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
    d2.candidates = [candidate({ timestamp: NOW + 1000, createdAt: NOW + 1000 })];
    state = advanceNarration(state, d2, "alive", NOW + 1000);
    const trade = state.entries.at(-1)!;
    expect(trade.kind).toBe("trade");
    expect(trade.text).toContain("PAPERで買いを記録しました");
    expect(trade.text).toContain("0.5 SUI");
    expect(trade.text).toContain("2.4312 USDC");
    const vital = botVital(d2, false, NOW, NOW);
    expect(agentPose(state, d2, vital)).toBe("pointSmile");
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
    expect(rejection.text).toContain("買いシグナルは出ましたが、見送りました");
    expect(rejection.text).toContain("手数料込みの利益が基準に届かないため見送り");
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
    expect(texts.some((t) => t.includes("DeepBookの通信に失敗しました"))).toBe(true);
    expect(texts.some((t) => t.includes("処理中にエラーが発生しました"))).toBe(false);
    expect(texts.some((t) => t.includes("止まりました。理由：APIの連続エラーを検出しました"))).toBe(true);
  });

  it("connectivity transitions narrate degradation and recovery once", () => {
    const { db, monitor, state } = started();
    const degraded = runningSnapshot(db, monitor, decision({ evaluatedAt: NOW }));
    degraded.safety.connectivity = "DEGRADED";
    const s2 = advanceNarration(state, degraded, "weak", NOW);
    expect(s2.entries.at(-1)!.text).toContain("通信が不安定になっています");
    const recovering = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW }),
    );
    recovering.safety.connectivity = "RECOVERING";
    recovering.safety.healthyCycles = 2;
    const s3 = advanceNarration(s2, recovering, "weak", NOW);
    expect(s3.entries.at(-1)!.text).toContain("正常サイクル2回を確認");
    const healthyAgain = runningSnapshot(
      db,
      monitor,
      decision({ evaluatedAt: NOW }),
    );
    const s4 = advanceNarration(s3, healthyAgain, "alive", NOW);
    expect(s4.entries.at(-1)!.kind).toBe("recovery");
    expect(s4.entries.at(-1)!.text).toContain("通信が復旧しました");
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
  it("weak (degraded) never points, even with 2/3 conditions met", () => {
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
    expect(agentPose(emptyNarrationState(), d, vital)).toBe("normal");
  });

  it("a safety stop sleeps", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    d.status = "ABNORMAL_STOP";
    d.safety.botState = "ABNORMAL_STOP";
    const vital = botVital(d, false, NOW, NOW);
    expect(vital.state).toBe("flatlined");
    expect(agentPose(emptyNarrationState(), d, vital)).toBe("sleep");
  });

  it("an alive bot with fewer than two conditions met stays normal", () => {
    const { db, monitor } = fixture();
    const d = runningSnapshot(db, monitor, decision({}));
    const vital = botVital(d, false, NOW, NOW);
    expect(vital.state).toBe("alive");
    expect(agentPose(emptyNarrationState(), d, vital)).toBe("normal");
  });
});

describe("agent narration: fail-closed", () => {
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
