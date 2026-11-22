import { describe, expect, it, vi } from "vitest";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import { RealTradeCapExecutor } from "../apps/worker/src/real/execution.ts";
import { RealTradeCapExecutionAdapter } from "../apps/worker/src/real/adapter.ts";
import { RealBookParamsCache } from "../apps/worker/src/real/book-params-cache.ts";
import { RealFeeCache } from "../apps/worker/src/real/fee-cache.ts";
import type { ExecutionIntent } from "../apps/worker/src/execution-adapter.ts";
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

const book = {
  pool_name: identity.poolKey,
  pool_id: "0x1c19362ca52b8ffd7a33cee805a67d40f31e6ba303753fd3a4cfdfacea7163a5",
  min_size: 1_000_000_000,
  lot_size: 100_000_000,
  tick_size: 10,
};
const indexerUrl = "https://indexer.invalid/base";
const bookResponse = () =>
  Response.json([{ ...book, pool_name: "OTHER_POOL", lot_size: 1 }, book]);

const buy = {
  orderId: "o",
  side: "BUY",
  markPrice: 0.60054,
  candleTimestamp: 1,
  quote: { minAmountOut: "1664401674", amountIn: "1", expiresAt: 2 },
} as ExecutionIntent;

const adapterFixtures = (
  maxOrderDbusdc = 1,
  fetchPools = vi.fn(async () => bookResponse()),
) => {
  const execute = vi.fn(async () => ({ status: "SUCCEEDED", digest: "d" }));
  const adapter = new RealTradeCapExecutionAdapter(
    { execute } as unknown as RealTradeCapExecutor,
    { maxOrderDbusdc },
    new RealFeeCache(async () => ({
      tradeParams: { takerFee: 0, makerFee: 0, stakeRequired: 0 },
    })),
    new RealBookParamsCache(
      { indexerUrl, poolKey: identity.poolKey },
      fetchPools,
    ),
  );
  return { adapter, execute, fetchPools };
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
    expect(await executor.execute(intent)).toEqual({
      status: "REJECTED",
      errorCode: "REAL_RECONCILIATION_PENDING",
    });
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
    const { adapter, execute } = adapterFixtures(0.95);
    await expect(adapter.execute(buy)).resolves.toEqual({
      status: "REJECTED",
      errorCode: "REAL_MAX_ORDER_EXCEEDED",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows an aligned order exactly at the REAL cap", async () => {
    const { adapter } = adapterFixtures(0.960864);
    await expect(
      adapter.execute({ ...buy, markPrice: 0.6005400045 }),
    ).resolves.toEqual({
      status: "SUBMITTED",
      digest: "d",
    });
  });

  it("persists aligned values for the November 21 order", async () => {
    const db = new RealTradeCapDatabase(":memory:");
    try {
      open(db);
      const persist = vi.spyOn(db, "persistBeforeSend");
      const f = fixtures();
      const executor = new RealTradeCapExecutor(
        db,
        identity,
        f.builder,
        f.signer,
        f.sender,
      );
      const fetchPools = vi.fn(async () => bookResponse());
      const adapter = new RealTradeCapExecutionAdapter(
        executor,
        { maxOrderDbusdc: 1 },
        undefined,
        new RealBookParamsCache(
          { indexerUrl, poolKey: identity.poolKey },
          fetchPools,
        ),
      );
      await expect(adapter.execute(buy)).resolves.toEqual({
        status: "SUBMITTED",
        digest: "digest-1",
      });
      expect(fetchPools).toHaveBeenCalledWith(
        new URL("https://indexer.invalid/get_pools"),
      );
      expect(persist).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: { price: 0.60054, quantity: 1.6, expiresAt: 301_000 },
        }),
      );
    } finally {
      db.close();
    }
  });

  it.each([
    ["1099999999", 1_050_000_000],
    ["99999999", 1_000_000_000],
  ])(
    "rejects quantity %s when lot alignment puts it below minimum %s",
    async (minAmountOut, minSize) => {
      const { adapter, execute } = adapterFixtures(
        1,
        vi.fn(async () => Response.json([{ ...book, min_size: minSize }])),
      );
      await expect(
        adapter.execute({
          ...buy,
          quote: { ...buy.quote, minAmountOut },
        }),
      ).resolves.toEqual({
        status: "REJECTED",
        errorCode: "REAL_QUANTITY_BELOW_MINIMUM",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    () => new Response(null, { status: 503 }),
    () => Response.json([{ ...book, pool_name: "OTHER_POOL" }]),
    () => Response.json([{ ...book, lot_size: 0 }]),
  ])(
    "rejects when no valid book parameters have been read",
    async (response) => {
      const { adapter, execute } = adapterFixtures(
        1,
        vi.fn(async () => response()),
      );
      await expect(adapter.execute(buy)).resolves.toEqual({
        status: "REJECTED",
        errorCode: "REAL_BOOK_PARAMS_UNAVAILABLE",
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("reuses parameters within an epoch and falls back after a failed refresh", async () => {
    const { adapter, execute, fetchPools } = adapterFixtures();
    await adapter.feeEstimate("BUY", 10);
    await adapter.execute(buy);
    await adapter.execute(buy);
    expect(fetchPools).toHaveBeenCalledTimes(1);

    fetchPools.mockRejectedValueOnce(new Error("Indexer unavailable"));
    await adapter.feeEstimate("BUY", 11);
    await expect(adapter.execute(buy)).resolves.toEqual({
      status: "SUBMITTED",
      digest: "d",
    });
    expect(fetchPools).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      expect.objectContaining({
        intent: { price: 0.60054, quantity: 1.6, expiresAt: 301_000 },
      }),
    );
  });

  it.each([
    ["BUY", 0.60054],
    ["SELL", 0.60054001],
  ] as const)(
    "aligns the %s price in its intended direction",
    async (side, price) => {
      const { adapter, execute } = adapterFixtures();
      await adapter.execute({
        ...buy,
        side,
        markPrice: 0.6005400045,
        quote: { ...buy.quote, amountIn: "1499999999" },
      });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          side,
          clientOrderId: side === "BUY" ? "11" : "12",
          intent: { price, quantity: side === "BUY" ? 1.6 : 1.4, expiresAt: 301_000 },
        }),
      );
    },
  );

  it.each([
    { cutoff: "candle end", side: "BUY", candleTimestamp: 1_800, ttl: 180_000 },
    { cutoff: "later quote", side: "BUY", candleTimestamp: 1_500, ttl: 15_000 },
    { cutoff: "five minutes", side: "SELL", candleTimestamp: 2_100, ttl: 300_000 },
  ] as const)(
    "sets REAL expiration at $cutoff",
    async ({ side, candleTimestamp, ttl }) => {
      const now = 1_920_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const { adapter, execute } = adapterFixtures();
        await adapter.execute({
          ...buy,
          side,
          candleTimestamp,
          quote: {
            ...buy.quote,
            amountIn: "1600000000",
            expiresAt: now + 15_000,
          },
        });
        expect(execute).toHaveBeenCalledWith(
          expect.objectContaining({
            intent: expect.objectContaining({ expiresAt: now + ttl }),
          }),
        );
      } finally {
        clock.mockRestore();
      }
    },
  );

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
