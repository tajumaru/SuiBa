import { afterEach, expect, it, vi } from "vitest";
import {
  ReadOnlySuiClient,
  type SuiObservation,
} from "../packages/sui-client/src/index.ts";
import { SUI, USDC, decimals } from "../packages/shared/src/index.ts";
import { withReadBudget } from "../packages/shared/src/read-budget-node.ts";
const clients: ReadOnlySuiClient[] = [];
afterEach(() => {
  clients.splice(0).forEach((c) => c.close());
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const events: SuiObservation[] = [];
  const c = new ReadOnlySuiClient(undefined, {
    onObservation: (e) => events.push(e),
    fetch: async () => {
      throw Error("EXTERNAL_NETWORK_FORBIDDEN");
    },
  });
  clients.push(c);
  const metadata = vi.fn(async ({ coinType }: { coinType: string }) => ({
    coinMetadata: { decimals: decimals(coinType) },
  }));
  const balance = vi.fn(async ({ coinType }: { coinType: string }) => ({
    balance: { coinType, balance: "0" },
  }));
  (c as unknown as { client: unknown }).client = {
    getCoinMetadata: metadata,
    getBalance: balance,
  };
  return { c, metadata, balance, events };
}
const owner = "0x" + "1".repeat(64);
it("only complete SUI+USDC health updates health cache; ordinary reads cannot renew its TTL", async () => {
  let now = 100000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { c, metadata, events } = fixture();
  await c.health();
  now += 100000;
  await c.balance(owner, USDC);
  await c.metadata(SUI);
  expect(c.readStatus.checkedAt).toBe(now);
  expect(c.status.checkedAt).toBe(100000);
  await c.health();
  expect(metadata).toHaveBeenCalledTimes(3);
  expect(events.filter((e) => e.layer === "HEALTH").at(-1)?.cacheHit).toBe(
    true,
  );
  now = 220000;
  await c.health();
  expect(metadata).toHaveBeenCalledTimes(5);
  expect(c.status).toEqual({ healthy: true, checkedAt: now, failures: 0 });
});
it.each([SUI, USDC])(
  "a failed %s health cannot be healed by a successful balance or metadata read",
  async (type) => {
    const { c, metadata, events } = fixture();
    metadata.mockImplementation(async ({ coinType }) => {
      if (coinType === type)
        throw Object.assign(Error("private resolver text"), {
          code: "EAI_AGAIN",
        });
      return { coinMetadata: { decimals: decimals(coinType) } };
    });
    await expect(c.health()).rejects.toThrow("SUI_READ_FAILED");
    expect(c.status).toMatchObject({ healthy: false, failures: 1 });
    const other = type === SUI ? USDC : SUI;
    await c.balance(owner, other);
    await c.metadata(other);
    expect(c.status.healthy).toBe(false);
    await expect(c.health()).rejects.toThrow("SUI_READ_FAILED");
    expect(metadata).toHaveBeenCalledTimes(5);
    expect(c.status.failures).toBe(2); // health cohorts, not RPC/read error count
    expect(JSON.stringify(events)).not.toContain("private resolver text");
  },
);
it("parallel health calls share a single cohort and never publish partial success", async () => {
  const { c, metadata, events } = fixture(),
    pending = deferred<{ coinMetadata: { decimals: number } }>();
  metadata.mockImplementation(async ({ coinType }) =>
    coinType === USDC ? pending.promise : { coinMetadata: { decimals: 9 } },
  );
  const checks = [c.health(), c.health(), c.health()];
  await Promise.resolve();
  expect(c.status.healthy).toBe(false);
  expect(metadata).toHaveBeenCalledTimes(2);
  pending.resolve({ coinMetadata: { decimals: 6 } });
  await Promise.all(checks);
  expect(c.status.healthy).toBe(true);
  expect(events.filter((e) => e.layer === "HEALTH")).toHaveLength(1);
});
it("concurrent fresh checks inside one budget coalesce without adding RPCs", async () => {
  const { c, metadata } = fixture();
  await withReadBudget(new AbortController().signal, true, () =>
    Promise.all([c.health(true), c.health(true)]),
  );
  expect(metadata).toHaveBeenCalledTimes(2);
});
it("a fresh recheck never exposes a previous healthy status while one coin is still pending", async () => {
  const { c, metadata } = fixture();
  await c.health();
  const pending = deferred<{ coinMetadata: { decimals: number } }>();
  metadata.mockImplementationOnce(() => pending.promise);
  const recheck = c.health(true);
  await Promise.resolve();
  expect(c.status.healthy).toBe(false);
  pending.resolve({ coinMetadata: { decimals: 9 } });
  await recheck;
  expect(c.status.healthy).toBe(true);
});
it("a fresh budget waits for an older cohort and performs its own complete check", async () => {
  const { c, metadata, events } = fixture(),
    pending = deferred<{ coinMetadata: { decimals: number } }>();
  metadata.mockImplementationOnce(() => pending.promise);
  const old = c.health();
  const fresh = withReadBudget(new AbortController().signal, true, () =>
    c.health(true),
  );
  expect(metadata).toHaveBeenCalledTimes(2);
  pending.resolve({ coinMetadata: { decimals: 9 } });
  await Promise.all([old, fresh]);
  expect(metadata).toHaveBeenCalledTimes(4);
  const health = events.filter((e) => e.layer === "HEALTH");
  expect(new Set(health.map((e) => e.healthId)).size).toBe(2);
});
it("a concurrent read failure invalidates late healthy replies from the older cohort", async () => {
  const { c, metadata, balance } = fixture(),
    pending = deferred<{ coinMetadata: { decimals: number } }>();
  metadata.mockImplementationOnce(() => pending.promise);
  const health = c.health();
  balance.mockRejectedValueOnce(Error("ECONNRESET"));
  await expect(c.balance(owner, SUI)).rejects.toThrow("SUI_READ_FAILED");
  pending.resolve({ coinMetadata: { decimals: 9 } });
  await expect(health).rejects.toThrow("SUI_READ_FAILED");
  expect(c.status.healthy).toBe(false);
  await c.health(true);
  expect(c.status.healthy).toBe(true);
});
it("aborts a stalled cohort at its existing parent budget and ignores late replies", async () => {
  const { c, metadata } = fixture(),
    pending = deferred<{ coinMetadata: { decimals: number } }>(),
    controller = new AbortController();
  metadata.mockImplementationOnce(() => pending.promise);
  const health = withReadBudget(controller.signal, true, () => c.health(true));
  controller.abort(Error("MARKET_DATA_STALLED"));
  await expect(health).rejects.toThrow("SUI_READ_FAILED");
  pending.resolve({ coinMetadata: { decimals: 9 } });
  await new Promise(setImmediate);
  expect(c.status.healthy).toBe(false);
  expect(c.status.failures).toBe(1);
});
it("a caller whose fresh budget expires while waiting cannot start extra reads", async () => {
  const { c, metadata } = fixture(),
    pending = deferred<{ coinMetadata: { decimals: number } }>(),
    controller = new AbortController();
  metadata.mockImplementationOnce(() => pending.promise);
  const older = c.health();
  const fresh = withReadBudget(controller.signal, true, () => c.health(true));
  controller.abort(Error("MARKET_DATA_STALLED"));
  await expect(fresh).rejects.toThrow("MARKET_DATA_STALLED");
  pending.resolve({ coinMetadata: { decimals: 9 } });
  await older;
  expect(metadata).toHaveBeenCalledTimes(2);
});
it("observation storage failure is fail-closed and does not grant healthy cache", async () => {
  const { c } = fixture();
  (c as unknown as { options: unknown }).options = {
    onObservation: () => {
      throw Error("secret DB error");
    },
  };
  await expect(c.health()).rejects.toThrow("VALIDATION_RECORD_FAILED");
  expect(c.status.healthy).toBe(false);
  await expect(c.health()).rejects.toThrow("VALIDATION_RECORD_FAILED");
});
it("a failed cache observation closes the existing healthy gate immediately", async () => {
  const { c } = fixture();
  await c.health();
  (c as unknown as { options: unknown }).options = {
    onObservation: () => {
      throw Error("private");
    },
  };
  await expect(c.health()).rejects.toThrow("VALIDATION_RECORD_FAILED");
  expect(c.status.healthy).toBe(false);
});
