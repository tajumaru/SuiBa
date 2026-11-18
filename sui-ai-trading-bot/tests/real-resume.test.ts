import { describe, expect, it, vi } from "vitest";
import {
  atomic,
  balanceEvidence,
  ENGINE_CHECKS_MAX_AGE_MS,
  readEngineChecks,
  resumeReal,
} from "../scripts/real-resume.ts";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import {
  TRADE_CAP_QUERY,
  tradeCapEvidence,
  tradeCapValid,
} from "../apps/worker/src/real/cap-valid.ts";
import {
  GAS_BALANCE_QUERY,
  graphqlGasBalance,
  remapPoolBalances,
  unwrapManagerBalance,
} from "../apps/worker/src/real/read-only.ts";
import type { RealIdentity } from "../apps/worker/src/real/types.ts";
const identity: RealIdentity = {
  network: "testnet",
  balanceManagerId: `0x${"1".repeat(64)}`,
  poolKey: "SUI_DBUSDC",
  tradeCapId: `0x${"2".repeat(64)}`,
  signerAddress: `0x${"3".repeat(64)}`,
  sessionId: "s",
};

const response = (value: unknown, ok = true) =>
  ({ ok, json: async () => value }) as Response;

describe("TradeCap chain proof", () => {
  const object = (
    owner = identity.signerAddress,
    manager = identity.balanceManagerId,
  ) => ({
    data: {
      object: {
        owner: { __typename: "AddressOwner", address: { address: owner } },
        asMoveObject: {
          contents: {
            type: { repr: "0xdee9::balance_manager::TradeCap" },
            json: { id: identity.tradeCapId, balance_manager_id: manager },
          },
        },
      },
    },
  });
  const valid = (value: unknown) =>
    tradeCapValid(
      "https://graphql.test",
      identity,
      vi.fn<typeof fetch>().mockResolvedValue(response(value)),
    );

  it("is true only when existence, owner, and manager proofs all hold", async () => {
    await expect(valid(object())).resolves.toBe(true);
    await expect(valid({ data: { object: null } })).resolves.toBe(false);
    await expect(valid(object(`0x${"4".repeat(64)}`))).resolves.toBe(false);
    await expect(
      valid(object(identity.signerAddress, `0x${"5".repeat(64)}`)),
    ).resolves.toBe(false);
  });

  it("fails closed on read failure", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    await expect(
      tradeCapValid("https://graphql.test", identity, request),
    ).resolves.toBe(false);
  });

  it("uses the live Move-object shape and surfaces query errors", async () => {
    expect(TRADE_CAP_QUERY).toContain("asMoveObject { contents");
    expect(TRADE_CAP_QUERY).not.toMatch(/\n\s+contents \{/);
    await expect(
      tradeCapEvidence(
        "https://graphql.test",
        identity,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response({ errors: [{ message: "schema drift" }] }),
          ),
      ),
    ).resolves.toMatchObject({ valid: false, queryErrored: true });
  });
});

describe("REAL gas GraphQL response", () => {
  it("uses coinType and accepts the live totalBalance string", () => {
    expect(GAS_BALANCE_QUERY).toContain('balance(coinType: "0x2::sui::SUI")');
    expect(GAS_BALANCE_QUERY).not.toContain("balance(type:");
    expect(
      graphqlGasBalance({
        data: { address: { balance: { totalBalance: "54069098983" } } },
      }),
    ).toBe("54069098983");
  });

  it.each([{ errors: [{ message: "schema drift" }] }, {}])(
    "throws instead of converting invalid GraphQL data to zero",
    (payload) => {
      expect(() => graphqlGasBalance(payload)).toThrow(/REAL_GRAPHQL/);
    },
  );
});

describe("durable REAL engine checks", () => {
  const record = (
    db: RealTradeCapDatabase,
    overrides: Partial<
      Parameters<RealTradeCapDatabase["persistEngineChecks"]>[0]
    > = {},
  ) =>
    db.persistEngineChecks({
      identity,
      recordedAt: 10_000,
      risk: "ALLOWED",
      profitGuard: "ALLOWED",
      market: "HEALTHY",
      ...overrides,
    });

  it("allows only a fresh affirmatively non-blocking record", () => {
    const db = new RealTradeCapDatabase(":memory:");
    record(db);
    expect(readEngineChecks(db, identity, 10_001)).toEqual({
      riskAllowed: true,
      profitGuardAllowed: true,
      marketHealthy: true,
    });
    db.close();
  });

  it("fails closed for absent, stale, blocking, and mismatched identity records", () => {
    const absent = new RealTradeCapDatabase(":memory:");
    expect(readEngineChecks(absent, identity, 10_001)).toEqual({
      riskAllowed: false,
      profitGuardAllowed: false,
      marketHealthy: false,
    });
    absent.close();

    const stale = new RealTradeCapDatabase(":memory:");
    record(stale);
    expect(
      Object.values(
        readEngineChecks(
          stale,
          identity,
          10_000 + ENGINE_CHECKS_MAX_AGE_MS + 1,
        ),
      ),
    ).toEqual([false, false, false]);
    stale.close();

    const blocking = new RealTradeCapDatabase(":memory:");
    record(blocking, {
      risk: "REJECTED",
      profitGuard: "BLOCKED",
      market: "UNHEALTHY",
    });
    expect(Object.values(readEngineChecks(blocking, identity, 10_001))).toEqual(
      [false, false, false],
    );
    blocking.close();

    const mismatch = new RealTradeCapDatabase(":memory:");
    record(mismatch, { identity: { ...identity, sessionId: "other" } });
    expect(Object.values(readEngineChecks(mismatch, identity, 10_001))).toEqual(
      [false, false, false],
    );
    mismatch.close();
  });
});

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
      availableAtomic: "1000000",
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

describe("REAL measured balance fixtures", () => {
  const rows = [
    {
      asset: "SUI",
      availableAtomic: "5000000000",
      orderLockedAtomic: "1250000000",
      settledUnclaimedAtomic: "0",
      feeAtomic: "0",
      gasMist: "0",
    },
    {
      asset: "DBUSDC",
      availableAtomic: "9890000",
      orderLockedAtomic: "0",
      settledUnclaimedAtomic: "250000",
      feeAtomic: "0",
      gasMist: "0",
    },
    {
      asset: "DEEP",
      availableAtomic: "114000000",
      orderLockedAtomic: "0",
      settledUnclaimedAtomic: "0",
      feeAtomic: "0",
      gasMist: "0",
    },
  ];
  const sdkBalances = {
    SUI: { coinType: "SUI", balance: 5 },
    DBUSDC: { coinType: "DBUSDC", balance: 9.89 },
    DEEP: { coinType: "DEEP", balance: 114 },
  };
  const snapshot = {
    balances: {
      SUI: unwrapManagerBalance(sdkBalances.SUI),
      DBUSDC: unwrapManagerBalance(sdkBalances.DBUSDC),
      DEEP: unwrapManagerBalance(sdkBalances.DEEP),
    },
    locked: remapPoolBalances("SUI_DBUSDC", {
      base: 1.25,
      quote: 0,
      deep: 0,
    }),
    settledUnclaimed: remapPoolBalances("SUI_DBUSDC", {
      base: 0,
      quote: 0.25,
      deep: 0,
    }),
    owedBalances: { SUI: 0, DBUSDC: 0, DEEP: 0 },
    botGasSuiMist: "0",
  };

  it("matches coin-atomic ledger rows with locked base and settled quote", () => {
    const evidence = balanceEvidence(rows, snapshot);
    expect(evidence.explained).toBe(true);
    expect(evidence.differences["SUI.locked"]).toBe("0");
    expect(evidence.differences["DBUSDC.settled"]).toBe("0");
  });

  it("uses the 1e6 DEEP coin scale and surfaces owed balances", () => {
    expect(balanceEvidence(rows, snapshot).differences["DEEP.available"]).toBe(
      "0",
    );
    expect(
      balanceEvidence(rows, {
        ...snapshot,
        owedBalances: { ...snapshot.owedBalances, DEEP: 1 },
      }).explained,
    ).toBe(false);
  });

  it("converts numeric float artifacts exactly and rejects malformed values", () => {
    expect(atomic(0.30000000000000004, 6)).toBe(300000n);
    expect(() => atomic("abc", 6)).toThrow("REAL_BALANCE_INVALID");
    expect(() => atomic({ balance: 1 } as unknown as string, 6)).toThrow(
      "REAL_BALANCE_INVALID",
    );
  });
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
          availableAtomicDelta: "1000000",
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
    expect(approved.details).toMatchObject({
      capValid: { queryErrored: false, failedConjuncts: [] },
      gasSufficient: {
        actualMist: "1",
        actualSui: "0.000000001",
        thresholdMist: "1",
        thresholdSui: "0.000000001",
      },
      reconciliation: { pages: 1, events: 0 },
    });
    expect(approved.opened).toBe(true);
    deps.db.close();
  });
  it.each(["cap", "engine"] as const)(
    "keeps the gate closed when the %s producer is false",
    async (producer) => {
      const deps = setup();
      if (producer === "cap") deps.capValid = async () => false;
      else
        deps.engineChecks = async () => ({
          riskAllowed: false,
          profitGuardAllowed: true,
          marketHealthy: true,
        });
      const result = await resumeReal(deps, {
        approve: true,
        ownerApproval: "reviewed",
      });
      expect(result.opened).toBe(false);
      deps.db.close();
    },
  );
  it("rejects a permanent latch", async () => {
    const deps = setup();
    deps.db.latch(identity, "REAL_UNIDENTIFIABLE_PREDECESSOR", "x", true);
    await expect(resumeReal(deps, { approve: false })).rejects.toThrow(
      "REAL_UNIDENTIFIABLE_PREDECESSOR",
    );
    deps.db.close();
  });
});
