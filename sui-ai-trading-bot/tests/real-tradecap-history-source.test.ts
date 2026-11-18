import { afterEach, describe, expect, it, vi } from "vitest";
import { IndexerGraphqlHistorySource } from "../apps/worker/src/real/history-source.ts";
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
                    transactionBlocks: {
                      nodes: [
                        {
                          digest: "tx",
                          effects: {
                            checkpoint: {
                              sequenceNumber: "100",
                              digest: "h100",
                            },
                            gasEffects: { gasSummary: { netGasUsage: "7" } },
                          },
                        },
                      ],
                      pageInfo: { hasNextPage: false, endCursor: null },
                    },
                  },
                }
              : {
                  data: {
                    transactionBlocks: {
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
});
