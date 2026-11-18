import { describe, expect, it, vi } from "vitest";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import { RealTradeCapExecutor } from "../apps/worker/src/real/execution.ts";
import { RealTradeCapExecutionAdapter } from "../apps/worker/src/real/adapter.ts";
import { createDeepBookTransactionBuilder } from "../apps/worker/src/real/deepbook-execution.ts";
import type { RealIdentity } from "../apps/worker/src/real/types.ts";

const identity: RealIdentity = {
  network: "testnet",
  balanceManagerId: `0x${"1".repeat(64)}`,
  poolKey: "SUI_DBUSDC",
  tradeCapId: `0x${"2".repeat(64)}`,
  signerAddress: `0x${"3".repeat(64)}`,
  sessionId: "phase1",
};
const checks = Object.fromEntries(
  [
    "allTransactionsTerminal",
    "historyComplete",
    "ledgerIdempotent",
    "balancesExplained",
    "noOpenOrders",
    "identityMatches",
    "capValid",
    "gasSufficient",
    "deepSufficient",
    "riskAllowed",
    "profitGuardAllowed",
    "marketHealthy",
  ].map((key) => [key, true]),
);
const open = (db: RealTradeCapDatabase) => {
  db.approveResume(identity, {
    checkpoint: "42",
    checkpointHash: "h42",
    identityKey: "fixed",
    ownerApproval: "owner-signature",
  });
  db.openSigningGate(identity, checks);
};
const fixtures = (
  send = vi.fn(async () => ({
    digest: "digest-1",
    success: true,
    checkpoint: "43",
    checkpointHash: "h43",
    events: [],
  })),
) => ({
  builder: {
    place: vi.fn(async () => ({
      digest: "digest-1",
      bytes: new Uint8Array([1]),
    })),
    cancel: vi.fn(async () => ({
      digest: "digest-cancel",
      bytes: new Uint8Array([2]),
    })),
  },
  signer: {
    address: identity.signerAddress,
    sign: vi.fn(async () => "bot-signature"),
  },
  sender: { send },
});
const intent = {
  internalOrderId: "real:testnet:1:BUY:1",
  clientOrderId: "1",
  side: "BUY" as const,
  intent: { side: "BUY" },
};

describe("REAL TradeCap execution and stop/resume gate", () => {
  it("does not sign or send when pre-send persistence fails", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    open(db);
    const f = fixtures();
    db.persistBeforeSend = vi.fn(() => {
      throw Error("disk full");
    });
    const executor = new RealTradeCapExecutor(
      db,
      identity,
      f.builder,
      f.signer,
      f.sender,
    );
    await expect(executor.execute(intent)).rejects.toThrow("disk full");
    expect(f.signer.sign).not.toHaveBeenCalled();
    expect(f.sender.send).not.toHaveBeenCalled();
    db.close();
  });

  it("S1 fences an old generation immediately when stop is accepted", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    open(db);
    const f = fixtures();
    f.builder.place.mockImplementationOnce(async () => {
      db.acceptStop(identity);
      return { digest: "digest-1", bytes: new Uint8Array([1]) };
    });
    const executor = new RealTradeCapExecutor(
      db,
      identity,
      f.builder,
      f.signer,
      f.sender,
    );
    await expect(executor.execute(intent)).rejects.toThrow(
      "REAL_SIGNING_HALTED",
    );
    expect(f.signer.sign).not.toHaveBeenCalled();
    expect(f.sender.send).not.toHaveBeenCalled();
    db.close();
  });

  it("keeps an unknown S2 submission pending and never resends the original", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    open(db);
    const f = fixtures(
      vi.fn(async () => {
        throw Error("timeout");
      }),
    );
    const executor = new RealTradeCapExecutor(
      db,
      identity,
      f.builder,
      f.signer,
      f.sender,
    );
    expect((await executor.execute(intent)).status).toBe("UNKNOWN");
    expect(await executor.execute({ ...intent, clientOrderId: "2" })).toEqual({
      status: "REJECTED",
      errorCode: "REAL_RECONCILIATION_PENDING",
    });
    expect(f.sender.send).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("S3 rejects bot cancellation while latched and requires confirmed failure", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    open(db);
    const f = fixtures();
    const executor = new RealTradeCapExecutor(
      db,
      identity,
      f.builder,
      f.signer,
      f.sender,
    );
    const cancel = { ...intent, targetOrderId: "99" };
    expect((await executor.cancel(cancel)).errorCode).toBe(
      "REAL_CANCEL_NOT_CONFIRMED_FAILED",
    );
    db.acceptStop(identity);
    expect(
      (
        await executor.cancel({
          ...cancel,
          confirmedFailedPreviousCancel: true,
        })
      ).errorCode,
    ).toBe("REAL_SIGNING_HALTED");
    expect(f.signer.sign).not.toHaveBeenCalled();
    db.close();
  });

  it("S4 refuses approval for a permanently unidentifiable identity", () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.latch(identity, "REAL_UNIDENTIFIABLE_PREDECESSOR", "BM mismatch", true);
    expect(() =>
      db.approveResume(identity, {
        checkpoint: "1",
        checkpointHash: "h",
        identityKey: "x",
        ownerApproval: "yes",
      }),
    ).toThrow("REAL_UNIDENTIFIABLE_PREDECESSOR");
    db.close();
  });

  it("rechecks a permanent latch when opening after approval", () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.approveResume(identity, {
      checkpoint: "1",
      checkpointHash: "h",
      identityKey: "x",
      ownerApproval: "yes",
    });
    db.latch(identity, "REAL_UNIDENTIFIABLE_PREDECESSOR", "late", true);
    expect(() => db.openSigningGate(identity, checks)).toThrow(
      "REAL_UNIDENTIFIABLE_PREDECESSOR",
    );
    db.close();
  });

  it("rejects an order above the REAL cap before build, sign, or send", async () => {
    const executor = {
      execute: vi.fn(),
      acceptStop: vi.fn(),
    } as unknown as RealTradeCapExecutor;
    const adapter = new RealTradeCapExecutionAdapter(executor, {
      maxOrderDbusdc: 0.1,
    });
    const result = await adapter.execute({
      orderId: "o",
      side: "BUY",
      markPrice: 2,
      candleTimestamp: 1,
      quote: { minAmountOut: "50000001", amountIn: "1", expiresAt: 2 },
    } as never);
    expect(result).toEqual({
      status: "REJECTED",
      errorCode: "REAL_MAX_ORDER_EXCEEDED",
    });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("allows an order exactly at the REAL cap", async () => {
    const executor = {
      execute: vi.fn(async () => ({ status: "SUCCEEDED", digest: "d" })),
      acceptStop: vi.fn(),
    } as unknown as RealTradeCapExecutor;
    const adapter = new RealTradeCapExecutionAdapter(executor, {
      maxOrderDbusdc: 0.1,
    });
    await expect(
      adapter.execute({
        orderId: "o",
        side: "BUY",
        markPrice: 2,
        candleTimestamp: 1,
        quote: { minAmountOut: "50000000", amountIn: "1", expiresAt: 2 },
      } as never),
    ).resolves.toEqual({ status: "SUBMITTED", digest: "d" });
  });

  it("fails explicitly when MARKET is configured", async () => {
    const client = { $extend: () => ({}) } as never;
    const builder = createDeepBookTransactionBuilder(client, {
      network: "testnet",
      balanceManagerId: identity.balanceManagerId,
      poolKey: identity.poolKey,
      tradeCapId: identity.tradeCapId,
      signerAddress: identity.signerAddress,
      sessionId: identity.sessionId,
      indexerUrl: "https://indexer.invalid",
      graphqlUrl: "https://graphql.invalid",
      grpcUrl: "https://grpc.invalid",
      maxOrderDbusdc: 0.1,
      orderType: "MARKET",
      signingEnabled: true,
    });
    await expect(builder.place(intent)).rejects.toThrow(
      "REAL_ORDER_TYPE_UNSUPPORTED",
    );
  });

  it("applies duplicate effects only once", () => {
    const db = new RealTradeCapDatabase(":memory:");
    const event = {
      chain: "sui:testnet" as const,
      checkpoint: "43",
      digest: "digest-1",
      eventSequence: "0",
      kind: "ORDER_FILLED" as const,
      identity,
      asset: "SUI" as const,
      availableAtomicDelta: "7",
      raw: {},
    };
    db.persistBeforeSend({
      digest: "digest-1",
      txBytes: new Uint8Array([1]),
      internalOrderId: intent.internalOrderId,
      clientOrderId: "1",
      identity,
      intent: {},
    });
    const effects = {
      digest: "digest-1",
      success: true,
      checkpoint: "43",
      checkpointHash: "h43",
      events: [event],
    };
    db.applyEffects(identity, effects);
    db.applyEffects(identity, effects);
    expect(db.ledgerCount()).toBe(1);
    db.close();
  });
});
