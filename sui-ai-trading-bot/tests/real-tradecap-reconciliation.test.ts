import { describe, expect, it } from "vitest";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import { RealReconciler } from "../apps/worker/src/real/reconciler.ts";
import { realConfigFromEnv } from "../apps/worker/src/real/config.ts";
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
});
