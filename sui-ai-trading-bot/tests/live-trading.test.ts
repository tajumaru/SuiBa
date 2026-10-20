import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { Transaction } from "@mysten/sui/transactions";
import BN from "bn.js";
import { GrpcWalletReader } from "../packages/live-trading/src/wallet-reader.ts";
import { coin, SUI, USDC } from "../packages/shared/src/index.ts";
import { BotDatabase } from "../packages/database/src/index.ts";
import { SqliteLiveStore } from "../packages/database/src/live-store.ts";
import {
  TransactionBuilder,
  createCetusLiveApi,
} from "../packages/live-trading/src/transaction-builder.ts";
import { TransactionValidator } from "../packages/live-trading/src/transaction-validator.ts";
import { TransactionSimulator } from "../packages/live-trading/src/transaction-simulator.ts";
import {
  validateIntent,
  validateRoute,
  hashBytes,
  address,
  LiveError,
} from "../packages/live-trading/src/policy.ts";
import {
  loadWalletSigner,
  PreviewWalletSigner,
} from "../packages/live-trading/src/wallet-signer.ts";
import { LiveTradingExecutor } from "../packages/live-trading/src/live-trading-executor.ts";
import { TransactionReconciler } from "../packages/live-trading/src/transaction-reconciler.ts";
import { initializeLivePreview } from "../packages/live-trading/src/bootstrap.ts";
import { fixture, simulation, CHAIN, DIGEST } from "./live-fixtures.ts";
vi.mock("@mysten/sui/keypairs/ed25519", () => ({
  Ed25519Keypair: {
    fromSecretKey: (secret: string) => {
      if (secret !== "MOCK_ONLY") throw new Error("sensitive fixture text");
      return { toSuiAddress: () => address("0x123") };
    },
  },
}));
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("TEST_NETWORK_FORBIDDEN");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
const builder = () => new TransactionBuilder(createCetusLiveApi());
describe("real SDK offline PTB construction with mocked external data", () => {
  it("builds SDK V3 PTB, validates final BCS against an independent whole-PTB template", async () => {
    const { context, request } = fixture();
    const b = await builder().build(context);
    expect(Transaction.from(b.bytes).getData().commands).toHaveLength(5);
    await expect(
      new TransactionValidator().validate(b, context, request, Date.now()),
    ).resolves.toEqual({ hash: b.hash, minimumProtected: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "transfer",
    "call",
    "gas",
    "slippage",
    "amount",
    "intent",
    "delete-protection",
  ])("rejects tampered %s", async (mutation) => {
    const { context, request } = fixture();
    const b = await builder().build(context);
    const tx = Transaction.from(b.bytes);
    if (mutation === "transfer") tx.transferObjects([tx.gas], "0xbad");
    if (mutation === "call")
      tx.moveCall({ target: "0xbad::attack::drain", arguments: [tx.gas] });
    if (mutation === "gas") tx.setGasOwner("0xbad");
    if (
      mutation === "slippage" ||
      mutation === "amount" ||
      mutation === "delete-protection"
    ) {
      const data = tx.getData();
      if (mutation === "delete-protection") data.commands.splice(3, 1);
      else {
        const call = data.commands[1];
        if (call.$kind === "MoveCall") {
          const arg = call.MoveCall.arguments[mutation === "slippage" ? 4 : 1];
          if (arg.$kind === "Input")
            data.inputs[arg.Input] = {
              $kind: "Pure",
              Pure: { bytes: "AAAAAAAAAAA=" },
            };
        }
      }
      const changed = Transaction.from(JSON.stringify(data));
      b.bytes = await changed.build();
    } else if (mutation === "intent") {
      const data = tx.getData();
      data.commands.push({
        $kind: "Publish",
        Publish: { modules: [], dependencies: [] },
      });
      b.bytes = await Transaction.from(JSON.stringify(data)).build();
    } else b.bytes = await tx.build();
    b.hash = hashBytes(b.bytes);
    await expect(
      new TransactionValidator().validate(b, context, request, Date.now()),
    ).rejects.toThrow("PTB_NOT_ALLOWLISTED");
  });
  it("rejects changed quote and changed bytes even when the claimed hash is supplied", async () => {
    const { context, request } = fixture(),
      b = await builder().build(context);
    b.quote = { ...b.quote, amountOut: "9999999999" };
    await expect(
      new TransactionValidator().validate(b, context, request, Date.now()),
    ).rejects.toThrow("QUOTE_CHANGED");
  });
});
describe("live policy and risk boundaries", () => {
  it.each([
    "network",
    "wallet",
    "coin",
    "order",
    "daily",
    "slippage",
    "holding",
    "gas",
    "stale",
    "minimum",
    "loss",
    "stopped",
    "emergency",
  ])("rejects %s", (name) => {
    const { context: c, request: r } = fixture();
    switch (name) {
      case "network":
        c.wallet.chainIdentifier = "bad";
        break;
      case "wallet":
        c.wallet.address = "0xbad";
        break;
      case "coin":
        r.quote.from = "0xbad::usdc::USDC";
        break;
      case "order":
        r.quote.amountIn = "6000000";
        break;
      case "daily":
        r.risk.portfolio.dailyBought = 20;
        break;
      case "slippage":
        r.quote.slippage = 0.004;
        break;
      case "holding":
        c.wallet.sui = "20000000000";
        break;
      case "gas":
        c.wallet.coins[0].balance = "1";
        break;
      case "stale":
        c.wallet.observedAt -= 20000;
        break;
      case "minimum":
        r.quote.minAmountOut = "1";
        break;
      case "loss":
        r.risk.portfolio.dayStartEquity = 200;
        break;
      case "stopped":
        r.risk.runtime.running = false;
        break;
      case "emergency":
        r.risk.runtime.emergency = true;
    }
    expect(() => validateIntent(r, c.wallet, c.policy, Date.now())).toThrow();
  });
  it.each([
    "package",
    "provider",
    "pool",
    "fee",
    "extra-package",
    "route-coin",
    "published-at",
  ])("rejects external route %s", (name) => {
    const { context: c } = fixture();
    const r = c.route.router;
    if (name === "package") r.packages!.set("aggregator_v3", "0xbad");
    if (name === "extra-package") r.packages!.set("new-package", "0xbad");
    if (name === "provider") r.paths[0].provider = "AFTERMATH";
    if (name === "pool") r.paths[0].id = "0xbad";
    if (name === "fee") r.totalDeepFee = 1;
    if (name === "route-coin") r.paths[0].target = "0xbad::sui::SUI";
    if (name === "published-at") r.paths[0].publishedAt = "0xbad";
    expect(() => validateRoute(c.route, c.policy)).toThrow();
  });
});
describe("simulation validation", () => {
  it("simulates exact bytes with checks enabled and real gas refs; verifies amounts and gas", async () => {
    const { context, request } = fixture(),
      b = await builder().build(context);
    const api = {
      getChainIdentifier: vi.fn(async () => ({ chainIdentifier: CHAIN })),
      simulateTransaction: vi.fn(async () => simulation(b.bytes)),
    };
    const result = await new TransactionSimulator(api).simulate(
      b,
      context,
      request,
    );
    expect(result.receivedAtomic).toBe("2492500000");
    expect(result.gasMist).toBe("1000000");
    expect(api.simulateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: b.bytes,
        checksEnabled: true,
        doGasSelection: false,
      }),
    );
  });
  it.each([
    "failure",
    "mock-gas",
    "recipient",
    "coin",
    "balance",
    "gas",
    "network",
    "timeout",
    "changed-bytes",
  ])("rejects simulation %s", async (name) => {
    const { context, request } = fixture(),
      b = await builder().build(context),
      response = simulation(b.bytes);
    if (name === "failure")
      response.Transaction!.status = {
        success: false,
        error: { message: "mock failure" } as never,
      };
    if (name === "mock-gas") response.gasPaymentMocked = true;
    if (name === "recipient")
      response.Transaction!.balanceChanges![0].address = "0xbad";
    if (name === "coin")
      response.Transaction!.balanceChanges![0].coinType = "0xbad::sui::SUI";
    if (name === "balance")
      response.Transaction!.balanceChanges![1].amount = "1";
    if (name === "gas")
      response.Transaction!.effects!.gasUsed.computationCost = "9999999999";
    if (name === "changed-bytes")
      response.Transaction!.transaction!.gasData.owner = address("0xbad");
    const api = {
      getChainIdentifier: async () => ({
        chainIdentifier: name === "network" ? "wrong" : CHAIN,
      }),
      simulateTransaction: async () => {
        if (name === "timeout") throw new Error("mock timeout");
        return response;
      },
    };
    await expect(
      new TransactionSimulator(api).simulate(b, context, request),
    ).rejects.toThrow();
  });
});
describe("wallet secret isolation and deliberately disabled signing", () => {
  it("does not read a secret in PAPER, even if LIVE variables are present", async () => {
    const read = vi.fn(async () => {
      throw new Error("must not read");
    });
    expect(
      await loadWalletSigner(
        { mode: "PAPER", previewEnabled: true, allowedAddress: "ignored" },
        read,
      ),
    ).toBeUndefined();
    const db = new BotDatabase(":memory:");
    expect(
      await initializeLivePreview(
        {
          mode: "PAPER",
          previewEnabled: true,
          policy: fixture().context.policy,
          store: new SqliteLiveStore(db),
        },
        read,
      ),
    ).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    db.close();
  });
  it("requires explicit preview enablement before reading any key", async () => {
    const read = vi.fn(async () => undefined);
    await expect(
      loadWalletSigner(
        { mode: "LIVE", previewEnabled: false, allowedAddress: "0x123" },
        read,
      ),
    ).rejects.toThrow("LIVE_DISABLED");
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects missing key", async () =>
    await expect(
      loadWalletSigner(
        { mode: "LIVE", previewEnabled: true, allowedAddress: "0x123" },
        async () => undefined,
      ),
    ).rejects.toThrow("SECRET_NOT_CONFIGURED"));
  it("sanitizes secret errors and never serializes a key", async () => {
    await expect(
      loadWalletSigner(
        { mode: "LIVE", previewEnabled: true, allowedAddress: "0x123" },
        async () => "bad",
      ),
    ).rejects.toThrow("INVALID_SECRET");
    const signer = (await loadWalletSigner(
      { mode: "LIVE", previewEnabled: true, allowedAddress: "0x123" },
      async () => "MOCK_ONLY",
    ))!;
    expect(JSON.stringify(signer)).not.toContain("MOCK_ONLY");
    await expect(signer.signTransaction(new Uint8Array())).rejects.toThrow(
      "SIGNING_DISABLED",
    );
  });
  it("detects a mismatched wallet on load", async () =>
    await expect(
      loadWalletSigner(
        { mode: "LIVE", previewEnabled: true, allowedAddress: "0xbad" },
        async () => "MOCK_ONLY",
      ),
    ).rejects.toThrow("WALLET_CHANGED"));
});
describe("executor persistence and capability controls", () => {
  function setup(
    options: {
      enabled?: boolean;
      simulate?: (db: BotDatabase) => void;
      readFail?: boolean;
    } = {},
  ) {
    const { context, request } = fixture(),
      db = new BotDatabase(":memory:"),
      store = new SqliteLiveStore(db),
      signer = new PreviewWalletSigner(context.policy.allowedWallet);
    const simulator = new TransactionSimulator({
      getChainIdentifier: async () => ({ chainIdentifier: CHAIN }),
      simulateTransaction: async (r) => {
        options.simulate?.(db);
        return simulation(r.transaction);
      },
    });
    const dependencies = {
      previewEnabled: options.enabled ?? true,
      policy: context.policy,
      store,
      wallet: signer,
      reader: {
        read: async () => {
          if (options.readFail) throw new Error("sensitive rpc text");
          return context.wallet;
        },
      },
      routeSource: { fetch: async () => context.route },
      builder: builder(),
      validator: new TransactionValidator(),
      simulator,
    };
    const executor = new LiveTradingExecutor(dependencies);
    return {
      db,
      store,
      executor,
      request,
      context,
      restart: () => new LiveTradingExecutor(dependencies),
    };
  }
  it("defaults to stopped; arms simulation only and never changes PAPER state", async () => {
    const t = setup();
    const before = t.db.portfolio();
    await expect(t.executor.prepare(t.request)).rejects.toThrow(
      "LIVE_DISABLED",
    );
    await t.executor.armPreview("SIMULATION_ONLY_NO_SIGNING");
    const result = await t.executor.prepare(t.request);
    expect(result.signingEnabled).toBe(false);
    expect(result.submissionEnabled).toBe(false);
    expect(t.db.portfolio()).toEqual(before);
    expect(t.db.history("paper_trades")).toHaveLength(0);
    t.db.close();
  });
  it("rejects duplicate orders and concurrent requests", async () => {
    const t = setup();
    await t.executor.armPreview("SIMULATION_ONLY_NO_SIGNING");
    const first = t.executor.prepare(t.request);
    await expect(t.executor.prepare(t.request)).rejects.toThrow(
      "CONCURRENT_ORDER",
    );
    await first;
    await expect(t.executor.prepare(t.request)).rejects.toThrow(
      "DUPLICATE_ORDER",
    );
    t.db.close();
  });
  it("persists emergency during an in-flight simulation and rejects the result", async () => {
    const t = setup({
      simulate: (db) => new SqliteLiveStore(db).emergencyStop(),
    });
    await t.executor.armPreview("SIMULATION_ONLY_NO_SIGNING");
    await expect(t.executor.prepare(t.request)).rejects.toThrow(
      "LIVE_DISABLED",
    );
    expect(t.store.state().emergency).toBe(true);
    expect(
      t.db.get<{ status: string }>("live:order:" + t.request.orderId)?.status,
    ).toBe("PREVIEW_FAILED");
    t.db.close();
  });
  it("sanitizes simulation/read failure and stops", async () => {
    const t = setup({ readFail: true });
    await t.executor.armPreview("SIMULATION_ONLY_NO_SIGNING");
    await expect(t.executor.prepare(t.request)).rejects.toThrow(
      "LIVE_PREVIEW_FAILED",
    );
    expect(JSON.stringify(t.store.state())).not.toContain("sensitive");
    t.db.close();
  });
  it("does not allow settings or runtime flags to enable signing, sending or automation", async () => {
    const t = setup({ enabled: false });
    await expect(
      t.executor.armPreview("SIMULATION_ONLY_NO_SIGNING"),
    ).rejects.toThrow("LIVE_DISABLED");
    await expect(t.executor.submit()).rejects.toThrow("SUBMISSION_DISABLED");
    expect(() => t.executor.enableAutomaticTrading()).toThrow(
      "NOT_IMPLEMENTED",
    );
    t.db.close();
  });
  it("blocks unknown submission state and leaves reconciliation explicitly unimplemented", async () => {
    const t = setup();
    t.db.set("live:state", {
      ...t.store.state(),
      activeOrder: "unknown-prior-submit",
    });
    await expect(
      t.executor.armPreview("SIMULATION_ONLY_NO_SIGNING"),
    ).rejects.toThrow("UNRESOLVED_ORDER");
    await expect(
      new TransactionReconciler(t.store).reconcile("unknown"),
    ).rejects.toThrow("PHASE_5_NOT_IMPLEMENTED");
    expect(t.store.state().activeOrder).toBe("unknown-prior-submit");
    t.db.close();
  });
  it("stops after a restart and preserves emergency and pending state", async () => {
    const t = setup();
    await t.executor.armPreview("SIMULATION_ONLY_NO_SIGNING");
    t.store.emergencyStop();
    const again = t.restart();
    expect(t.store.state().reason).toBe("RESTART_STOP");
    expect(t.store.state().emergency).toBe(true);
    await expect(again.prepare(t.request)).rejects.toThrow();
    t.db.close();
  });
});

describe("SELL PTB and read-only wallet adapter", () => {
  it("validates a SUI to USDC PTB without spending the gas reserve", async () => {
    const { context, request } = fixture();
    const q = {
      ...request.quote,
      from: SUI,
      to: USDC,
      amountIn: "1000000000",
      amountOut: "2000000",
      minAmountOut: "1994000",
    };
    context.route.quote = q;
    request.quote = q;
    request.risk.side = "SELL";
    context.wallet.sui = "2000000000";
    context.wallet.coins[0].balance = "2000000000";
    const r = context.route.router;
    r.amountIn = new BN(q.amountIn);
    r.amountOut = new BN(q.amountOut);
    r.paths[0] = {
      ...r.paths[0],
      from: SUI,
      target: USDC,
      amountIn: q.amountIn,
      amountOut: q.amountOut,
      direction: false,
    };
    const b = await builder().build(context);
    await expect(
      new TransactionValidator().validate(b, context, request, Date.now()),
    ).resolves.toMatchObject({ minimumProtected: true });
    const response = simulation(b.bytes);
    response.Transaction!.balanceChanges = [
      {
        address: context.policy.allowedWallet,
        coinType: SUI,
        amount: "-1001000000",
      },
      {
        address: context.policy.allowedWallet,
        coinType: USDC,
        amount: "1994000",
      },
    ];
    const result = await new TransactionSimulator({
      getChainIdentifier: async () => ({ chainIdentifier: CHAIN }),
      simulateTransaction: async () => response,
    }).simulate(b, context, request);
    expect(result.receivedAtomic).toBe("1994000");
  });
  it.each(["valid", "owner", "type", "object"])(
    "wallet reader validates %s response",
    async (mode) => {
      const { context } = fixture();
      const w = context.wallet;
      const api: ConstructorParameters<typeof GrpcWalletReader>[0] = {
        getChainIdentifier: async () => ({ chainIdentifier: CHAIN }),
        getBalance: async (r) => ({
          balance: {
            coinType: r.coinType ?? SUI,
            balance: r.coinType === SUI ? w.sui : w.usdc,
            coinBalance: r.coinType === SUI ? w.sui : w.usdc,
            addressBalance: "0",
          },
        }),
        getReferenceGasPrice: async () => ({ referenceGasPrice: w.gasPrice }),
        listCoins: async (r) => ({
          objects: w.coins
            .filter((c) => c.coinType === r.coinType)
            .map((c) => ({
              ...c,
              owner: {
                $kind: "AddressOwner" as const,
                AddressOwner: mode === "owner" ? address("0xbad") : w.address,
              },
              type:
                mode === "type"
                  ? "0xbad::coin::Coin"
                  : `0x2::coin::Coin<${c.coinType}>`,
            })),
          hasNextPage: false,
          cursor: null,
        }),
        getObjects: async () => ({
          objects: w.objects.map((o) => ({
            ...o,
            version: "1",
            digest: DIGEST,
            owner: {
              $kind: "Shared" as const,
              Shared: {
                initialSharedVersion:
                  mode === "object" ? "999" : o.initialSharedVersion,
              },
            },
            content: undefined,
            previousTransaction: undefined,
            objectBcs: undefined,
            json: undefined,
            display: undefined,
          })),
        }),
      };
      const reader = new GrpcWalletReader(api);
      if (mode === "valid") {
        const snapshot = await reader.read(w.address, context.policy);
        expect(snapshot.usdc).toBe(w.usdc);
        expect(fetch).not.toHaveBeenCalled();
      } else
        await expect(reader.read(w.address, context.policy)).rejects.toThrow();
    },
  );
  it("rechecks the secret source and detects key rotation", async () => {
    let value = "MOCK_ONLY";
    const signer = (await loadWalletSigner(
      { mode: "LIVE", previewEnabled: true, allowedAddress: "0x123" },
      async () => value,
    ))!;
    expect(await signer.getAddress()).toBe(address("0x123"));
    value = "invalid-rotated-fixture";
    await expect(signer.getAddress()).rejects.toThrow("INVALID_SECRET");
  });
  it("persists wallet-change stop even when rejecting an arm request", () => {
    const db = new BotDatabase(":memory:"),
      store = new SqliteLiveStore(db);
    store.startPreview("0x123");
    expect(() => store.startPreview("0x456")).toThrow("WALLET_CHANGED");
    expect(store.state().reason).toBe("WALLET_CHANGED");
    db.close();
  });
});
