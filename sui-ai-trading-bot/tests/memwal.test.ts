import { describe, expect, it, vi } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import {
  MemwalFlusher,
  dailyReviewEpisode,
  enqueueSettledShadowEpisodes,
  memwalConfig,
  narrationEpisode,
  shadowEpisode,
  type MemwalClient,
} from "../apps/worker/src/memwal.ts";

const configured = {
  SUIBA_MEMWAL_ENABLED: "true",
  MEMWAL_PRIVATE_KEY: "delegate",
  MEMWAL_ACCOUNT_ID: "account",
  MEMWAL_RELAYER_URL: "https://relayer.example",
  MEMWAL_NAMESPACE: "suiba",
};

describe("MemWal mirror", () => {
  it("is a complete no-op unless the opt-in and every credential are present", async () => {
    expect(memwalConfig({})).toBeNull();
    expect(memwalConfig({ ...configured, MEMWAL_ACCOUNT_ID: "" })).toBeNull();
    expect(memwalConfig(configured)).toEqual({
      privateKey: "delegate",
      accountId: "account",
      serverUrl: "https://relayer.example",
      namespace: "suiba",
    });
    const db = {
      memwalPending: vi.fn(),
      memwalSent: vi.fn(),
      memwalFailed: vi.fn(),
    };
    await new MemwalFlusher(db, null).flush(10_000);
    expect(db.memwalPending).not.toHaveBeenCalled();
  });

  it("queues all three curated kinds transactionally and deduplicates sources", () => {
    const db = new BotDatabase(":memory:");
    db.transaction(() => {
      db.enqueueMemwal("shadow", "shadow episode", "shadow-1", 1_000);
      db.enqueueMemwal("daily_review", "review lesson", "review-1", 1_000);
      db.enqueueMemwal("narration", "watch hit", "narration-1", 1_000);
      db.enqueueMemwal("narration", "duplicate", "narration-1", 1_000);
    });
    expect(db.memwalStatus()).toEqual({ pending: 3, lastSuccessAt: null });
    expect(db.memwalPending(6_000)).toHaveLength(3);
    db.close();
  });

  it("flushes accepted jobs once, records failures, and observes exponential backoff", async () => {
    const db = new BotDatabase(":memory:");
    db.enqueueMemwal("narration", "curated only", "episode-1", 1_000);
    const remember = vi
      .fn<MemwalClient["remember"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ id: "job-1" });
    const flusher = new MemwalFlusher(db, { remember });
    await flusher.flush(6_000);
    expect(db.memwalStatus().pending).toBe(1);
    expect(db.memwalPending(10_999)).toHaveLength(0);
    await flusher.flush(11_000);
    expect(remember).toHaveBeenLastCalledWith(
      "curated only",
      expect.any(String),
    );
    expect(db.memwalStatus()).toEqual({ pending: 0, lastSuccessAt: 11_000 });
    await flusher.flush(99_000);
    expect(remember).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("curates a shadow decision only after its exact +4h close exists", () => {
    const db = new BotDatabase(":memory:");
    const origin = 1_800_000_000;
    db.append("shadow_decisions", "cycle-1", {
      cycleId: "cycle-1",
      pair: "SUI_USDC",
      candleTimestamp: origin,
      action: "BUY",
      confidence: 0.72,
      ruleAction: "WAIT",
      selectedRule: "RSI_RECOVERY",
      status: "OK",
      snapshot: { candle: { close: 2 } },
    });
    db.saveCandles([
      {
        timestamp: origin,
        open: 2,
        high: 2,
        low: 2,
        close: 2,
        volume: 1,
        source: "test",
        timeframe: 300,
      },
      {
        timestamp: origin + 4 * 3600,
        open: 2.1,
        high: 2.1,
        low: 2.1,
        close: 2.1,
        volume: 1,
        source: "test",
        timeframe: 300,
      },
    ]);
    enqueueSettledShadowEpisodes(db, 20_000);
    expect(db.memwalPending(25_000)[0]?.text).toContain("+4h=5.00%");
    enqueueSettledShadowEpisodes(db, 30_000);
    expect(db.memwalStatus().pending).toBe(1);
    db.close();
  });

  it("locks the three append-only episode formats", () => {
    expect(
      shadowEpisode({
        at: 0,
        pair: "SUI_USDC",
        action: "BUY",
        price: 2.1,
        confidence: 0.72,
        ruleAction: "WAIT",
        selectedRule: "RSI_RECOVERY",
        return4hPct: 1.25,
      }),
    ).toMatchInlineSnapshot(
      `"[shadow] 1970-01-01T00:00:00.000Z SUI_USDC: AI=BUY (confidence 72%), price=$2.1000; rule=WAIT/RSI_RECOVERY; +4h=1.25%."`,
    );
    expect(
      dailyReviewEpisode({ at: 0, lesson: "下降局面では待つ" }),
    ).toMatchInlineSnapshot(
      `"[daily-review] 1970-01-01T00:00:00.000Z lesson: 下降局面では待つ"`,
    );
    expect(
      narrationEpisode({ at: 0, kind: "watchHit", pair: "SUI_USDC" }),
    ).toMatchInlineSnapshot(
      `"[narration/watchHit] 1970-01-01T00:00:00.000Z SUI_USDC: 注目条件が成立した。"`,
    );
  });
});
