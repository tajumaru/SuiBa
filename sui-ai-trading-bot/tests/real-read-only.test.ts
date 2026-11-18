import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "@mysten/deepbook-v3";
import {
  remapPoolBalances,
  resolveAccount,
  unwrapManagerBalance,
} from "../apps/worker/src/real/read-only.ts";

const account: AccountInfo = {
  epoch: "7",
  open_orders: { contents: ["order"] },
  taker_volume: 1,
  maker_volume: 2,
  active_stake: 3,
  inactive_stake: 4,
  created_proposal: true,
  voted_proposal: "5",
  unclaimed_rebates: { base: 6, quote: 7, deep: 8 },
  settled_balances: { base: 9, quote: 10, deep: 11 },
  owed_balances: { base: 12, quote: 13, deep: 14 },
};

describe("REAL read-only account resolution", () => {
  it("returns the typed zero account without querying a missing account", async () => {
    const accountQuery = vi.fn(async () => account);
    const result = await resolveAccount(
      { accountExists: vi.fn(async () => false), account: accountQuery },
      "SUI_DBUSDC",
    );

    expect(accountQuery).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      epoch: "0",
      open_orders: { contents: [] },
      settled_balances: { base: 0, quote: 0, deep: 0 },
      owed_balances: { base: 0, quote: 0, deep: 0 },
      unclaimed_rebates: { base: 0, quote: 0, deep: 0 },
    });
  });

  it("propagates an account query failure when the account exists", async () => {
    await expect(
      resolveAccount(
        {
          accountExists: vi.fn(async () => true),
          account: vi.fn(async () => {
            throw new Error("account failed");
          }),
        },
        "SUI_DBUSDC",
      ),
    ).rejects.toThrow("account failed");
  });

  it("passes an existing account through unchanged", async () => {
    await expect(
      resolveAccount(
        {
          accountExists: vi.fn(async () => true),
          account: vi.fn(async () => account),
        },
        "SUI_DBUSDC",
      ),
    ).resolves.toBe(account);
  });
});

describe("REAL SDK snapshot normalization", () => {
  it("unwraps SDK manager balances and maps pool-relative balances", () => {
    expect(unwrapManagerBalance({ coinType: "SUI", balance: 5 })).toBe(5);
    expect(remapPoolBalances("SUI_DBUSDC", { base: 1, quote: 2, deep: 3 }))
      .toEqual({ SUI: 1, DBUSDC: 2, DEEP: 3 });
  });

  it("fails closed for malformed balances and unmapped pools", () => {
    expect(() => unwrapManagerBalance({ balance: "5" })).toThrow(
      "REAL_BALANCE_INVALID",
    );
    expect(() =>
      remapPoolBalances("UNKNOWN", { base: 1, quote: 2, deep: 3 }),
    ).toThrow("REAL_POOL_ASSET_MAPPING_UNSUPPORTED");
  });
});

it("loads repo-root dotenv before every REAL CLI dependency", () => {
  for (const script of [
    "real-resume.ts",
    "real-swap.ts",
    "real-phase1-evidence.ts",
    "real-owner-cli.ts",
  ]) {
    const source = readFileSync(
      new URL(`../scripts/${script}`, import.meta.url),
      "utf8",
    );
    expect(source.startsWith('import "dotenv/config";')).toBe(true);
  }
});
