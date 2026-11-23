import trades from "./fixtures/real-testnet-sui-dbusdc-trades-20261122.json";
import effects from "./fixtures/real-testnet-sui-dbusdc-effects-20261122.json";
import { balanceEvidence } from "../apps/worker/src/real/balance-evidence.ts";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import { RealReconciler } from "../apps/worker/src/real/reconciler.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_QUERY,
  IndexerGraphqlHistorySource,
  SUBMISSION_QUERY,
  netGasUsage,
} from "../apps/worker/src/real/history-source.ts";
import type { RealIdentity } from "../apps/worker/src/real/types.ts";

const identity: RealIdentity = {
  network: "testnet",
  balanceManagerId: `0x${"1".repeat(64)}`,
  poolKey: "SUI_DBUSDC",
  tradeCapId: `0x${"2".repeat(64)}`,
  signerAddress: `0x${"3".repeat(64)}`,
  sessionId: "s",
};
afterEach(() => vi.unstubAllGlobals());

describe("REAL history source", () => {
  it("keeps checkpoint continuity on an empty page and uses a stable effects key", async () => {
    let graphqlCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        if (/\/(orders|trades)\//.test(String(input)))
          return { ok: true, json: async () => [] };
        graphqlCall++;
        return {
          ok: true,
          json: async () =>
            graphqlCall === 1
              ? {
                  data: {
                    transactions: {
                      nodes: [
                        {
                          digest: "tx",
                          effects: {
                            timestamp: "invalid date",
                            checkpoint: {
                              sequenceNumber: "100",
                              digest: "h100",
                            },
                            gasEffects: {
                              gasSummary: {
                                computationCost: "5",
                                storageCost: "4",
                                storageRebate: "2",
                              },
                            },
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                }
              : {
                  data: {
                    transactions: {
                      nodes: [],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                },
        } as Response;
      }),
    );
    const source = new IndexerGraphqlHistorySource(
      "https://indexer.invalid",
      "https://graphql.invalid",
      identity,
    );
    const first = await source.page(null);
    const empty = await source.page(null);
    expect(first.events[0]).toMatchObject({
      eventSequence: "effects:history",
      asset: "SUI",
      gasMist: "7",
    });
    expect(first.events[0].timestampMs).toBeUndefined();
    expect(empty).toMatchObject({ checkpoint: "100", checkpointHash: "h100" });
  });

  it("uses live transaction fields and computes net gas components", () => {
    expect(HISTORY_QUERY).toContain("transactions(");
    expect(HISTORY_QUERY).toContain("affectedObject: $address");
    expect(HISTORY_QUERY).toContain(
      "computationCost storageCost storageRebate",
    );
    expect(HISTORY_QUERY).not.toContain("transactionBlocks");
    expect(SUBMISSION_QUERY).toContain("transaction(digest: $digest)");
    expect(
      netGasUsage({
        computationCost: "100",
        storageCost: "40",
        storageRebate: "25",
      }),
    ).toBe("115");
  });

  it.each([{ errors: [{ message: "schema drift" }] }, {}])(
    "throws instead of treating an invalid GraphQL response as empty",
    async (payload) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL) =>
          /\/(orders|trades)\//.test(String(input))
            ? ({ ok: true, json: async () => [] } as Response)
            : ({ ok: true, json: async () => payload } as Response),
        ),
      );
      const source = new IndexerGraphqlHistorySource(
        "https://indexer.invalid",
        "https://graphql.invalid",
        identity,
      );
      await expect(source.page(null)).rejects.toThrow(/REAL_HISTORY_GRAPHQL/);
    },
  );
});

it.each(["legacy", "before", "after"] as const)(
  "reconciles six trade legs and five testnet transactions with %s baseline handling",
  async (timing) => {
    const db = new RealTradeCapDatabase(":memory:");
    const actualIdentity = {
      ...identity,
      balanceManagerId: trades[0].taker_balance_manager_id,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(input);
        if (url.pathname.startsWith("/orders/")) return Response.json([]);
        if (url.pathname.startsWith("/trades/")) {
          expect(url.pathname).toBe("/trades/SUI_DBUSDC");
          expect(url.searchParams.get("taker_balance_manager_id")).toBe(
            actualIdentity.balanceManagerId,
          );
          return Response.json(trades);
        }
        const nodes = effects.map((tx) => ({
          ...tx,
          effects: {
            ...tx.effects,
            timestamp: new Date(
              trades.find((trade) => trade.digest === tx.digest)!.timestamp,
            ).toISOString(),
          },
        }));
        return Response.json({ data: { transactions: { nodes } } });
      }),
    );
    const bucket = (availableAtomic: string) => ({
      availableAtomic,
      lockedAtomic: "0",
      settledUnclaimedAtomic: "0",
      owedAtomic: "0",
    });
    const offset = {
      availableAtomic: "0",
      lockedAtomic: "0",
      settledUnclaimedAtomic: "0",
      feeAtomic: "0",
      gasMist: "0",
    };
    const recordedAt =
      timing === "after"
        ? Math.min(...trades.map((trade) => trade.timestamp)) - 1
        : Math.max(...trades.map((trade) => trade.timestamp));
    db.recordBalanceBaseline(
      actualIdentity,
      {
        assets: {
          SUI: bucket("5000000000"),
          DBUSDC: bucket("9890000"),
          DEEP: bucket("114000000"),
        },
        botGasSuiMist: "54066086793",
        ledgerOffsets:
          timing === "legacy"
            ? undefined
            : {
                SUI: { ...offset },
                DBUSDC: { ...offset },
                DEEP: { ...offset },
              },
      },
      recordedAt,
    );
    for (const tx of effects) {
      const checkpoint = String(tx.effects.checkpoint.sequenceNumber);
      const checkpointHash = tx.effects.checkpoint.digest;
      db.persistBeforeSend({
        digest: tx.digest,
        txBytes: new Uint8Array(),
        internalOrderId: tx.digest,
        clientOrderId: "17953512001",
        identity: actualIdentity,
        intent: {},
        side: "BUY",
      });
      db.applyEffects(actualIdentity, {
        digest: tx.digest,
        success: true,
        checkpoint,
        checkpointHash,
        events: [
          {
            chain: "sui:testnet",
            checkpoint,
            digest: tx.digest,
            eventSequence: "effects:0",
            kind: "TX_EFFECTS",
            identity: actualIdentity,
            raw: {},
          },
        ],
      });
    }
    const history = new IndexerGraphqlHistorySource(
      "https://indexer.invalid",
      "https://graphql.invalid",
      actualIdentity,
    );
    const reconciler = new RealReconciler(db, actualIdentity, history);
    expect(db.hasUnreflectedBuy(actualIdentity)).toBe(true);
    await expect(reconciler.reconcileAllPages()).resolves.toMatchObject({
      events: 23,
    });
    await expect(reconciler.reconcileAllPages()).resolves.toMatchObject({
      events: 0,
    });
    expect(db.hasUnreflectedBuy(actualIdentity)).toBe(false);
    const fees = db
      .ledgerEvents(actualIdentity)
      .filter((event) => event.kind === "TRADE_FEE");
    expect(fees.map((event) => event.feeAtomic)).toEqual([
      "46331",
      "46331",
      "46331",
      "46331",
      "18532",
      "41600",
    ]);
    expect(fees.map((event) => event.eventSequence)).toEqual(
      trades.map((trade) => `trade-fee:${trade.trade_id}`),
    );
    const count = db.appliedTradeFeeCount(actualIdentity);
    expect(count).toBe(6);
    const rows = db.balanceLedger(actualIdentity);
    expect(rows.find((row) => row.asset === "SUI")?.gasMist).toBe("4043856");
    const baseline = db.balanceBaseline(actualIdentity);
    expect(baseline?.recordedAt).toBe(recordedAt);
    if (timing !== "legacy") {
      const evidence = balanceEvidence(
        rows,
        {
          balances: { SUI: "5", DBUSDC: "9.89", DEEP: "114" },
          locked: {},
          settledUnclaimed: {},
          botGasSuiMist: "54066086793",
        },
        baseline,
      );
      if (timing === "before") {
        expect(evidence.explained).toBe(true);
        expect(new Set(Object.values(evidence.differences))).toEqual(
          new Set(["0"]),
        );
        expect(baseline?.ledgerOffsets?.DEEP.feeAtomic).toBe("245456");
        expect(baseline?.ledgerOffsets?.SUI.gasMist).toBe("4043856");
      } else {
        expect(evidence.differences["SUI.available"]).toBe("-7500000000");
        expect(evidence.differences["SUI.gas"]).toBe("4043856");
        expect(baseline?.ledgerOffsets?.SUI).toEqual(offset);
      }
      return;
    }
    const compare = (deep: string, feeCount = count) =>
      balanceEvidence(
        rows,
        {
          balances: { SUI: "12.5", DBUSDC: "1.9352", DEEP: deep },
          locked: {},
          settledUnclaimed: {},
          botGasSuiMist: "54062042937",
        },
        db.balanceBaseline(actualIdentity),
        feeCount,
      );
    const evidence = compare("113.754543");
    expect(evidence.explained).toBe(true);
    expect(evidence.differences["DEEP.available"]).toBe("-1");
    expect(
      Object.entries(evidence.differences).filter(
        ([key, value]) => key !== "DEEP.available" && value !== "0",
      ),
    ).toEqual([]);
    expect(compare("113.754537")).toMatchObject({
      explained: false,
      differences: { "DEEP.available": "-7" },
    });
    expect(compare("113.754545")).toMatchObject({
      explained: false,
      differences: { "DEEP.available": "1" },
    });
    expect(compare("113.754543", 0).explained).toBe(false);
  },
);
