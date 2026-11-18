import { describe, expect, it } from "vitest";
import { balanceEvidence, resumeReal } from "../scripts/real-resume.ts";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import type { RealIdentity } from "../apps/worker/src/real/types.ts";
const identity: RealIdentity = {
  network: "testnet",
  balanceManagerId: `0x${"1".repeat(64)}`,
  poolKey: "SUI_DBUSDC",
  tradeCapId: `0x${"2".repeat(64)}`,
  signerAddress: `0x${"3".repeat(64)}`,
  sessionId: "s",
};

it("reports zero and nonzero balance differences", () => {
  const snapshot = {
    balances: { SUI: "1", DBUSDC: "0", DEEP: "1" },
    locked: {},
    settledUnclaimed: {},
    botGasSuiMist: "0",
  };
  const rows = [
    {
      asset: "SUI",
      availableAtomic: "1000000000",
      orderLockedAtomic: "0",
      settledUnclaimedAtomic: "0",
      feeAtomic: "0",
      gasMist: "0",
    },
    {
      asset: "DEEP",
      availableAtomic: "1000000000",
      orderLockedAtomic: "0",
      settledUnclaimedAtomic: "0",
      feeAtomic: "0",
      gasMist: "0",
    },
  ];
  expect(balanceEvidence(rows, snapshot).explained).toBe(true);
  expect(
    balanceEvidence(rows, {
      ...snapshot,
      balances: { ...snapshot.balances, DEEP: "2" },
    }).explained,
  ).toBe(false);
});

describe("REAL resume", () => {
  const setup = () => {
    const db = new RealTradeCapDatabase(":memory:");
    db.registerIdentity(identity);
    db.applyPage(
      identity,
      [
        {
          chain: "sui:testnet",
          checkpoint: "1",
          digest: "gas",
          eventSequence: "effects:0",
          kind: "TX_EFFECTS",
          identity,
          asset: "SUI",
          gasMist: "1",
          raw: {},
        },
        {
          chain: "sui:testnet",
          checkpoint: "1",
          digest: "deep",
          eventSequence: "balance:0",
          kind: "ASSET_MOVED",
          identity,
          asset: "DEEP",
          availableAtomicDelta: "1000000000",
          raw: {},
        },
      ],
      { cursor: null, checkpoint: "1", checkpointHash: "h1" },
    );
    return {
      db,
      identity,
      reconcile: async () => ({
        pages: 1,
        events: 0,
        nextCursor: null as null,
      }),
      snapshot: async () => ({
        balances: { SUI: "0", DBUSDC: "0", DEEP: "1" },
        openOrderIds: [],
        locked: {},
        settledUnclaimed: {},
        botGasSuiMist: "1",
      }),
      capValid: async () => true,
      engineChecks: async () => ({
        riskAllowed: true,
        profitGuardAllowed: true,
        marketHealthy: true,
      }),
    };
  };
  it("does not open without --approve and opens when every check is true", async () => {
    const deps = setup();
    expect((await resumeReal(deps, { approve: false })).opened).toBe(false);
    const approved = await resumeReal(deps, {
      approve: true,
      ownerApproval: "reviewed",
    });
    expect(approved.checks).toEqual(
      Object.fromEntries(
        Object.keys(approved.checks).map((key) => [key, true]),
      ),
    );
    expect(approved.opened).toBe(true);
    deps.db.close();
  });
  it("rejects a permanent latch", async () => {
    const deps = setup();
    deps.db.latch(identity, "REAL_UNIDENTIFIABLE_PREDECESSOR", "x", true);
    await expect(resumeReal(deps, { approve: false })).rejects.toThrow(
      "REAL_UNIDENTIFIABLE_PREDECESSOR",
    );
    deps.db.close();
  });
});
