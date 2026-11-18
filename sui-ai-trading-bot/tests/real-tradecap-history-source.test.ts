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
        if (String(input).includes("/orders/"))
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
      eventSequence: "effects:0",
      asset: "SUI",
      gasMist: "7",
    });
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
          String(input).includes("/orders/")
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
