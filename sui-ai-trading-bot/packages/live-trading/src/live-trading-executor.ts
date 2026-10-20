import type { TradingExecutor } from "../../shared/src/execution.ts";
import { LiveError, address, requireLive, validateIntent } from "./policy.ts";
import type {
  LiveRequest,
  LivePolicy,
  LiveStore,
  WalletReader,
  PreviewResult,
  LiveRoute,
} from "./types.ts";
import type { WalletSigner } from "./wallet-signer.ts";
import { TransactionBuilder } from "./transaction-builder.ts";
import { TransactionValidator } from "./transaction-validator.ts";
import { TransactionSimulator } from "./transaction-simulator.ts";
import { TransactionReconciler } from "./transaction-reconciler.ts";
export class LiveTradingExecutor implements TradingExecutor<
  "LIVE",
  LiveRequest,
  PreviewResult
> {
  readonly mode = "LIVE" as const;
  #armed = false;
  #busy = false;
  constructor(
    private deps: {
      previewEnabled: boolean;
      policy: LivePolicy;
      store: LiveStore;
      wallet: WalletSigner;
      reader: WalletReader;
      routeSource: { fetch(r: LiveRequest, p: LivePolicy): Promise<LiveRoute> };
      builder: TransactionBuilder;
      validator: TransactionValidator;
      simulator: TransactionSimulator;
    },
  ) {
    this.deps = { ...deps, policy: structuredClone(deps.policy) };
    deps.store.stop("RESTART_STOP");
  }
  async armPreview(confirmation: "SIMULATION_ONLY_NO_SIGNING") {
    requireLive(
      this.deps.previewEnabled && confirmation === "SIMULATION_ONLY_NO_SIGNING",
      "LIVE_DISABLED",
    );
    requireLive(!this.deps.store.state().emergency, "EMERGENCY_STOP");
    new TransactionReconciler(this.deps.store).assertNoUnresolvedSubmission();
    const wallet = address(await this.deps.wallet.getAddress());
    requireLive(
      wallet === address(this.deps.policy.allowedWallet),
      "WALLET_CHANGED",
    );
    this.deps.store.startPreview(wallet);
    this.#armed = true;
  }
  private async assertActive() {
    const state = this.deps.store.state();
    requireLive(
      this.#armed &&
        this.deps.previewEnabled &&
        !state.emergency &&
        !state.reason,
      "LIVE_DISABLED",
    );
    requireLive(
      address(await this.deps.wallet.getAddress()) ===
        address(this.deps.policy.allowedWallet) &&
        state.walletAddress === address(this.deps.policy.allowedWallet),
      "WALLET_CHANGED",
    );
  }
  async prepare(original: LiveRequest): Promise<PreviewResult> {
    requireLive(!this.#busy, "CONCURRENT_ORDER");
    this.#busy = true;
    let reserved = false;
    const d = this.deps;
    const request = structuredClone(original);
    try {
      await this.assertActive();
      d.store.reserve(request.orderId);
      reserved = true;
      const policy = structuredClone(d.policy);
      const wallet = await d.reader.read(policy.allowedWallet, policy);
      validateIntent(request, wallet, policy, Date.now());
      const route = await d.routeSource.fetch(request, policy);
      const context = { policy, wallet, route };
      const built = await d.builder.build(context);
      await d.validator.validate(built, context, request, Date.now());
      await this.assertActive();
      const simulation = await d.simulator.simulate(built, context, request);
      await this.assertActive();
      await d.validator.validate(built, context, request, Date.now());
      const result: PreviewResult = {
        mode: "LIVE",
        status: "SIMULATED_ONLY",
        orderId: request.orderId,
        transactionHash: built.hash,
        walletAddress: policy.allowedWallet,
        simulation,
        signingEnabled: false,
        submissionEnabled: false,
      };
      d.store.complete(request.orderId, result);
      return result;
    } catch (error) {
      this.#armed = false;
      const code =
        error instanceof LiveError ? error.code : "LIVE_PREVIEW_FAILED";
      if (reserved) d.store.fail(request.orderId, code);
      else d.store.stop(code);
      throw new LiveError(code);
    } finally {
      this.#busy = false;
    }
  }
  async submit(): Promise<never> {
    throw new LiveError("SUBMISSION_DISABLED_PHASE_1_3");
  }
  enableAutomaticTrading(): never {
    throw new LiveError("AUTOMATIC_TRADING_NOT_IMPLEMENTED");
  }
}
