import { describe, expect, it, vi } from "vitest";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import { startRealTradeCapReconciliation } from "../apps/worker/src/real/runtime.ts";
import { RealReconciler } from "../apps/worker/src/real/reconciler.ts";
import { realConfigFromEnv } from "../apps/worker/src/real/config.ts";
import { reconcileRealReadOnlyOnce } from "../apps/worker/src/real/index.ts";
import type {
  HistoryPage,
  RealHistoryEvent,
  RealIdentity,
} from "../apps/worker/src/real/types.ts";

const id = (suffix = "1"): RealIdentity => ({
  network: "testnet",
  balanceManagerId: `0x${suffix.repeat(64)}`,
  poolKey: "SUI_DBUSDC",
  tradeCapId: `0x${"2".repeat(64)}`,
  signerAddress: `0x${"3".repeat(64)}`,
  sessionId: "phase1",
});
const event = (
  kind: RealHistoryEvent["kind"],
  sequence: string,
  identity = id(),
): RealHistoryEvent => ({
  chain: "sui:testnet",
  checkpoint: "42",
  digest: `digest-${sequence}`,
  eventSequence: sequence,
  kind,
  identity,
  internalOrderId: "real:testnet:1:BUY:1",
  clientOrderId: "1",
  asset: "SUI",
  availableAtomicDelta: kind === "ORDER_FILLED" ? "10" : "0",
  orderLockedAtomicDelta: kind === "ORDER_CANCELLED" ? "-2" : "0",
  settledUnclaimedAtomicDelta: kind === "ORDER_FILLED" ? "3" : "0",
  gasMist: kind === "TX_EFFECTS" ? "5" : "0",
  raw: { fixture: kind },
});
const source = (pages: HistoryPage[]) => ({
  async page(cursor: string | null) {
    return pages[cursor === null ? 0 : Number(cursor)]!;
  },
});

describe("REAL TradeCap periodic reconciliation", () => {
  it("retries after a failed scan and resolves only submissions with a known status", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new RealTradeCapDatabase(":memory:");
    const identity = id();
    for (const [index, digest] of ["success", "failure", "pending"].entries()) {
      db.persistBeforeSend({
        digest,
        txBytes: new Uint8Array([index]),
        internalOrderId: `order-${index}`,
        clientOrderId: String(index),
        identity,
        intent: {},
      });
    }
    db.markSubmission("failure", "UNKNOWN");
    db.markSubmission("pending", "UNKNOWN");
    const page = vi.fn().mockRejectedValueOnce(Error("offline test"))
      .mockResolvedValue({
        events: [],
        nextCursor: null,
        checkpoint: "42",
        checkpointHash: "h42",
      });
    const submissionStatus = vi.fn(async (digest: string) => {
      if (digest === "success") return "SUCCEEDED" as const;
      if (digest === "failure") return "FAILED" as const;
      return null;
    });
    const stop = startRealTradeCapReconciliation(
      new RealReconciler(db, identity, { page, submissionStatus }),
    );
    try {
      expect(page).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(error).toHaveBeenCalledWith("REAL_TRADECAP_RECONCILIATION_FAILED");
      expect(db.nonTerminalSubmissions(identity)).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(submissionStatus).toHaveBeenCalledTimes(3);
      expect(db.nonTerminalSubmissions(identity)).toEqual([
        { digest: "pending", state: "UNKNOWN" },
      ]);
      expect(info).toHaveBeenCalledWith(JSON.stringify({
        event: "REAL_TRADECAP_RECONCILED",
        pages: 1,
        events: 0,
      }));
      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(page).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      db.close();
      info.mockRestore();
      error.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("REAL TradeCap read-only reconciliation", () => {
  it("S1 durably records the digest, bytes hash, IDs and full identity before any send", () => {
    const db = new RealTradeCapDatabase(":memory:");
    const hash = db.persistBeforeSend({
      digest: "tx-unknown",
      txBytes: new Uint8Array([1, 2, 3]),
      internalOrderId: "real:testnet:1:BUY:1",
      clientOrderId: "1",
      identity: id(),
      intent: { side: "BUY" },
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.ledgerCount()).toBe(0);
    db.close();
  });

  it("S2 scans every page after an OOM and does not double-account a fill on rescan", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    const pages = [
      {
        events: [event("TX_EFFECTS", "0")],
        nextCursor: "1",
        checkpoint: "41",
        checkpointHash: "h41",
      },
      {
        events: [event("ORDER_FILLED", "1")],
        nextCursor: null,
        checkpoint: "42",
        checkpointHash: "h42",
      },
    ];
    await new RealReconciler(db, id(), source(pages)).reconcileAllPages();
    expect(db.ledgerCount()).toBe(2);
    db.applyPage(id(), [event("ORDER_FILLED", "1")], {
      cursor: null,
      checkpoint: "42",
      checkpointHash: "h42",
    });
    expect(db.ledgerCount()).toBe(2);
    expect(db.checkpoint()).toEqual({
      cursor: null,
      checkpoint: "42",
      checkpointHash: "h42",
    });
    db.close();
  });

  it("replays two applied pages without latching and still resolves an UNKNOWN submission", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    try {
      const first = { ...event("TX_EFFECTS", "1"), checkpoint: "41" };
      const second = event("TX_EFFECTS", "2");
      const reconciler = new RealReconciler(db, id(), {
        ...source([
          { events: [first], nextCursor: "1", checkpoint: "41", checkpointHash: "h41" },
          { events: [second], nextCursor: null, checkpoint: "42", checkpointHash: "h42" },
        ]),
        submissionStatus: async () => "SUCCEEDED" as const,
      });
      await expect(reconciler.reconcileAllPages()).resolves.toMatchObject({
        pages: 2, events: 2,
      });
      db.persistBeforeSend({
        digest: "pending",
        txBytes: new Uint8Array([1]),
        internalOrderId: "o1",
        clientOrderId: "1",
        identity: id(),
        intent: {},
      });
      db.markSubmission("pending", "UNKNOWN");
      const applyPage = vi.spyOn(db, "applyPage");
      await expect(reconciler.reconcileAllPages()).resolves.toMatchObject({
        pages: 2, events: 0,
      });
      expect(applyPage).not.toHaveBeenCalled();
      expect(db.hasLatch(id())).toBe(false);
      expect(db.ledgerCount()).toBe(2);
      expect(db.nonTerminalSubmissions(id())).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("replays applied pages after replacing the TradeCap and applies new events", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    try {
      const oldIdentity = id();
      const newIdentity = { ...oldIdentity, tradeCapId: `0x${"4".repeat(64)}` };
      const pages = [
        {
          events: [{ ...event("ORDER_FILLED", "1", oldIdentity), checkpoint: "41" }],
          nextCursor: "1",
          checkpoint: "41",
          checkpointHash: "h41",
        },
        {
          events: [event("ORDER_FILLED", "2", oldIdentity)],
          nextCursor: null,
          checkpoint: "42",
          checkpointHash: "h42",
        },
      ];
      await new RealReconciler(db, oldIdentity, source(pages)).reconcileAllPages();
      const checkpoint = { cursor: null, checkpoint: "42", checkpointHash: "h42" };
      expect(db.checkpoint()).toEqual(checkpoint);
      expect(db.ledgerCount()).toBe(2);

      const replayPages = pages.map((page) => ({
        ...page,
        events: page.events.map((entry) => ({ ...entry, identity: newIdentity })),
      }));
      const reconciler = new RealReconciler(db, newIdentity, source(replayPages));
      await expect(reconciler.reconcileAllPages()).resolves.toMatchObject({
        pages: 2, events: 0,
      });
      expect(db.ledgerCount()).toBe(2);
      expect(db.checkpoint()).toEqual(checkpoint);
      expect(db.hasLatch(newIdentity)).toBe(false);

      const next = { ...event("ORDER_FILLED", "3", newIdentity), checkpoint: "43" };
      replayPages[1]!.nextCursor = "2";
      replayPages.push({
        events: [next],
        nextCursor: null,
        checkpoint: "43",
        checkpointHash: "h43",
      });
      await expect(reconciler.reconcileAllPages()).resolves.toMatchObject({
        pages: 3, events: 1,
      });
      expect(db.ledgerCount()).toBe(3);
      expect(db.ledgerEvents(newIdentity)).toEqual([next]);
      expect(db.balanceLedger(newIdentity)).toMatchObject([
        { asset: "SUI", availableAtomic: "10", settledUnclaimedAtomic: "3" },
      ]);
      expect(db.checkpoint()).toEqual({
        cursor: null, checkpoint: "43", checkpointHash: "h43",
      });
    } finally {
      db.close();
    }
  });

  it("replays pages applied before timestampMs existed, after a TradeCap change", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    try {
      const oldIdentity = id();
      const newIdentity = { ...oldIdentity, tradeCapId: `0x${"4".repeat(64)}` };
      // 旧コードが保存した形：timestampMs を持たないイベント。
      const stored = [
        {
          events: [{ ...event("ORDER_FILLED", "1", oldIdentity), checkpoint: "41" }],
          nextCursor: "1",
          checkpoint: "41",
          checkpointHash: "h41",
        },
        {
          events: [event("TX_EFFECTS", "2", oldIdentity)],
          nextCursor: null,
          checkpoint: "42",
          checkpointHash: "h42",
        },
      ];
      await new RealReconciler(db, oldIdentity, source(stored)).reconcileAllPages();
      expect(db.ledgerCount()).toBe(2);

      // 新コードの再取得：同じ出来事に timestampMs が付き、identity も新しい。
      const fresh = stored.map((page) => ({
        ...page,
        events: page.events.map((entry) => ({
          ...entry,
          identity: newIdentity,
          timestampMs: 1763800000000,
        })),
      }));
      const reconciler = new RealReconciler(db, newIdentity, source(fresh));
      await expect(reconciler.reconcileAllPages()).resolves.toMatchObject({
        pages: 2, events: 0,
      });
      expect(db.ledgerCount()).toBe(2);
      expect(db.hasLatch(newIdentity)).toBe(false);
    } finally {
      db.close();
    }
  });

  it.each(["missing", "changed"])(
    "latches an older page with a %s ledger event even when its last event matches",
    async (caseName) => {
      const db = new RealTradeCapDatabase(":memory:");
      try {
        const first = { ...event("TX_EFFECTS", "1"), checkpoint: "41" };
        const last = { ...event("TX_EFFECTS", "2"), checkpoint: "41" };
        const applied = caseName === "missing"
          ? [last]
          : [{ ...first, raw: { changed: true } }, last];
        db.applyPage(id(), applied, {
          cursor: null, checkpoint: "42", checkpointHash: "h42",
        });
        const reconciler = new RealReconciler(db, id(), source([{
          events: [first, last],
          nextCursor: null,
          checkpoint: "41",
          checkpointHash: "h41",
        }]));
        await expect(reconciler.reconcileAllPages()).rejects.toThrow(
          "REAL_CHECKPOINT_REGRESSION",
        );
        expect(db.latchInfo(id(), "REAL_CHECKPOINT_REGRESSION")).toBeTruthy();
        expect(db.ledgerEvents(id())).toEqual(applied);
      } finally {
        db.close();
      }
    },
  );

  it("applies only new ledger entries and balance deltas on an overlapping page", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    try {
      const existing = event("ORDER_FILLED", "1");
      const next = { ...event("ORDER_FILLED", "2"), checkpoint: "43" };
      db.applyPage(id(), [existing], {
        cursor: null, checkpoint: "42", checkpointHash: "h42",
      });
      const reconciler = new RealReconciler(db, id(), source([{
        events: [existing, next],
        nextCursor: null,
        checkpoint: "43",
        checkpointHash: "h43",
      }]));
      await expect(reconciler.reconcileAllPages()).resolves.toMatchObject({
        pages: 1, events: 1,
      });
      expect(db.ledgerEvents(id())).toEqual([existing, next]);
      expect(db.balanceLedger(id())).toMatchObject([
        { asset: "SUI", availableAtomic: "20", settledUnclaimedAtomic: "6" },
      ]);
      expect(db.checkpoint()?.checkpoint).toBe("43");
    } finally {
      db.close();
    }
  });

  it("checks the fresh checkpoint hash after fetching, even for identical ledger events", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    try {
      const applied = event("TX_EFFECTS", "1");
      const reconciler = new RealReconciler(db, id(), {
        async page() {
          db.applyPage(id(), [applied], {
            cursor: null, checkpoint: "42", checkpointHash: "h42",
          });
          return {
            events: [applied],
            nextCursor: null,
            checkpoint: "42",
            checkpointHash: "different",
          };
        },
      });
      await expect(reconciler.reconcileAllPages()).rejects.toThrow(
        "REAL_CHECKPOINT_HASH_MISMATCH",
      );
      expect(db.latchInfo(id(), "REAL_CHECKPOINT_HASH_MISMATCH")).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("charges gas only for a digest persisted as this bot's submission", () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.persistBeforeSend({
      digest: "bot-digest",
      txBytes: new Uint8Array([1]),
      internalOrderId: "o1",
      clientOrderId: "1",
      identity: id(),
      intent: {},
    });
    db.applyPage(
      id(),
      [
        {
          ...event("TX_EFFECTS", "bot-gas"),
          digest: "bot-digest",
          gasMist: "5",
        },
        {
          ...event("TX_EFFECTS", "owner-gas"),
          digest: "owner-digest",
          gasMist: "99",
        },
      ],
      { cursor: null, checkpoint: "42", checkpointHash: "h42" },
    );
    expect(
      db.balanceLedger(id()).find((row) => row.asset === "SUI")?.gasMist,
    ).toBe("5");
    db.close();
  });

  it("runs the read-only reconciliation loop with a fixture source", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    const result = await reconcileRealReadOnlyOnce({
      db,
      identity: id(),
      source: source([
        {
          events: [event("TX_EFFECTS", "0")],
          nextCursor: null,
          checkpoint: "42",
          checkpointHash: "h42",
        },
      ]),
      snapshot: async () => ({ openOrderIds: [] }),
    });
    expect(result).toMatchObject({ pages: 1, events: 1, openOrders: 0 });
    db.close();
  });

  it("S3 keeps cancel effects and competing fills as separate idempotency keys", () => {
    const db = new RealTradeCapDatabase(":memory:");
    const fill = {
      ...event("ORDER_FILLED", "4"),
      digest: "shared-digest",
      remainingAtomic: "2",
    };
    const cancel = {
      ...event("ORDER_CANCELLED", "5"),
      digest: "shared-digest",
      remainingAtomic: "0",
    };
    db.applyPage(id(), [fill, cancel], {
      cursor: null,
      checkpoint: "42",
      checkpointHash: "h42",
    });
    expect(db.ledgerCount()).toBe(2);
    db.close();
  });

  it("S4 latches a mismatched BM without mixing its events", () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.applyPage(id(), [event("ORDER_FILLED", "9", id("a"))], {
      cursor: null,
      checkpoint: "42",
      checkpointHash: "h42",
    });
    expect(db.ledgerCount()).toBe(0);
    expect(db.latchInfo(id(), "REAL_IDENTITY_MISMATCH")?.permanent).toBe(0);
    db.latch(id(), "REAL_UNIDENTIFIABLE_PREDECESSOR", "missing history", true);
    db.latch(id(), "REAL_UNIDENTIFIABLE_PREDECESSOR", "operator retry", false);
    expect(
      db.latchInfo(id(), "REAL_UNIDENTIFIABLE_PREDECESSOR")?.permanent,
    ).toBe(1);
    db.close();
  });

  it("requires a separate REAL database and keeps signing closed", () => {
    const env = {
      REAL_DATABASE_PATH: "data/real.sqlite",
      REAL_BALANCE_MANAGER_ID: id().balanceManagerId,
      REAL_TRADE_CAP_ID: id().tradeCapId,
      REAL_SIGNER_ADDRESS: id().signerAddress,
      REAL_SESSION_ID: "phase1",
      REAL_DEEPBOOK_INDEXER_URL: "https://indexer.invalid/history",
      REAL_SUI_GRAPHQL_URL: "https://graphql.invalid/graphql",
      REAL_SUI_GRPC_URL: "https://fullnode.testnet.sui.io",
    };
    expect(realConfigFromEnv(env).config.signingEnabled).toBe(false);
    expect(() =>
      realConfigFromEnv({ ...env, DATABASE_PATH: "data/bot.sqlite" }),
    ).toThrow("PAPER_DATABASE_PATH_FORBIDDEN_IN_REAL");
    expect(
      realConfigFromEnv({ ...env, REAL_SIGNING_ENABLED: "true" }).config
        .signingEnabled,
    ).toBe(true);
  });

  it("resolves UNKNOWN only when the chain confirms a terminal status", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.persistBeforeSend({
      digest: "confirmed",
      txBytes: new Uint8Array([1]),
      internalOrderId: "o1",
      clientOrderId: "1",
      identity: id(),
      intent: {},
    });
    db.markSubmission("confirmed", "UNKNOWN");
    await new RealReconciler(db, id(), {
      ...source([
        {
          events: [],
          nextCursor: null,
          checkpoint: "42",
          checkpointHash: "h42",
        },
      ]),
      submissionStatus: async () => "SUCCEEDED" as const,
    }).reconcileAllPages();
    expect(db.hasNonTerminalSubmission(id())).toBe(false);
    db.close();
  });

  it("keeps UNKNOWN when finality cannot be established", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.persistBeforeSend({
      digest: "missing",
      txBytes: new Uint8Array([1]),
      internalOrderId: "o1",
      clientOrderId: "1",
      identity: id(),
      intent: {},
    });
    db.markSubmission("missing", "UNKNOWN");
    await new RealReconciler(db, id(), {
      ...source([
        {
          events: [],
          nextCursor: null,
          checkpoint: "42",
          checkpointHash: "h42",
        },
      ]),
      submissionStatus: async () => null,
    }).reconcileAllPages();
    expect(db.hasNonTerminalSubmission(id())).toBe(true);
    db.close();
  });

  it("latches and throws on checkpoint regression", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.applyPage(id(), [], {
      cursor: null,
      checkpoint: "100",
      checkpointHash: "h100",
    });
    await expect(
      new RealReconciler(
        db,
        id(),
        source([
          {
            events: [],
            nextCursor: null,
            checkpoint: "99",
            checkpointHash: "h99",
          },
        ]),
      ).reconcileAllPages(),
    ).rejects.toThrow("REAL_CHECKPOINT_REGRESSION");
    expect(db.latchInfo(id(), "REAL_CHECKPOINT_REGRESSION")).toBeTruthy();
    db.close();
  });

  it("accepts sender effects and the same checkpoint history hash", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.persistBeforeSend({
      digest: "d",
      txBytes: new Uint8Array([1]),
      internalOrderId: "o",
      clientOrderId: "1",
      identity: id(),
      intent: {},
    });
    db.applyEffects(id(), {
      digest: "d",
      success: true,
      checkpoint: "50",
      checkpointHash: "true-hash",
      events: [],
    });
    await expect(
      new RealReconciler(
        db,
        id(),
        source([
          {
            events: [],
            nextCursor: null,
            checkpoint: "50",
            checkpointHash: "true-hash",
          },
        ]),
      ).reconcileAllPages(),
    ).resolves.toMatchObject({ pages: 1 });
    expect(db.checkpoint()?.checkpointHash).toBe("true-hash");
    db.close();
  });
});
