import { SuiGrpcClient } from "@mysten/sui/grpc";
import { bounded } from "../../shared/src/index.ts";
import { address, requireLive, validateWallet, LiveError } from "./policy.ts";
import { loadWalletSigner } from "./wallet-signer.ts";
import { GrpcWalletReader } from "./wallet-reader.ts";
import {
  TransactionBuilder,
  CetusLiveRouteSource,
  createCetusLiveApi,
} from "./transaction-builder.ts";
import { TransactionSimulator } from "./transaction-simulator.ts";
import { TransactionValidator } from "./transaction-validator.ts";
import { LiveTradingExecutor } from "./live-trading-executor.ts";
import type { LivePolicy, LiveStore, SimulationApi } from "./types.ts";
/** Server-only opt-in composition root. Not imported by the dashboard or the PAPER worker. */
export async function initializeLivePreview(
  options: {
    mode: "PAPER" | "LIVE";
    previewEnabled: boolean;
    policy: LivePolicy;
    store: LiveStore;
    grpcUrl?: string;
  },
  readSecret: () => Promise<string | undefined>,
) {
  if (options.mode === "PAPER") return undefined;
  const { store, policy } = options;
  store.stop("RESTART_STOP");
  try {
    requireLive(options.previewEnabled, "LIVE_DISABLED");
    const url = new URL(
      options.grpcUrl ?? "https://fullnode.mainnet.sui.io:443",
    );
    requireLive(
      url.protocol === "https:" && !url.username && !url.password,
      "INVALID_GRPC_URL",
    );
    const wallet = await loadWalletSigner(
      {
        mode: "LIVE",
        previewEnabled: options.previewEnabled,
        allowedAddress: policy.allowedWallet,
      },
      readSecret,
    );
    requireLive(wallet, "SECRET_NOT_CONFIGURED");
    const client = new SuiGrpcClient({
      network: "mainnet",
      baseUrl: url.toString(),
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          signal: AbortSignal.any([
            AbortSignal.timeout(9000),
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
    });
    // The unified chain identifier is cached by the SDK; use fresh service info for every safety check.
    const getChainIdentifier = async () => {
      const r = await bounded(
        async () => await client.ledgerService.getServiceInfo({}),
      );
      requireLive(r.response.chainId, "NETWORK_UNVERIFIED");
      return { chainIdentifier: r.response.chainId };
    };
    const reader = new GrpcWalletReader({
      getChainIdentifier,
      getBalance: client.getBalance.bind(client),
      listCoins: client.listCoins.bind(client),
      getReferenceGasPrice: client.getReferenceGasPrice.bind(client),
      getObjects: client.getObjects.bind(client),
    });
    const snapshot = await reader.read(await wallet.getAddress(), policy);
    validateWallet(snapshot, policy, Date.now());
    if (store.state().walletAddress)
      requireLive(
        store.state().walletAddress === address(snapshot.address),
        "WALLET_CHANGED",
      );
    const simulation: SimulationApi = {
      getChainIdentifier,
      simulateTransaction: (request) => client.simulateTransaction(request),
    };
    const api = createCetusLiveApi();
    return new LiveTradingExecutor({
      previewEnabled: options.previewEnabled,
      policy,
      store,
      wallet,
      reader,
      routeSource: new CetusLiveRouteSource(api),
      builder: new TransactionBuilder(api),
      validator: new TransactionValidator(),
      simulator: new TransactionSimulator(simulation),
    });
  } catch (error) {
    const code =
      error instanceof LiveError ? error.code : "LIVE_INITIALIZATION_FAILED";
    store.stop(code);
    throw new LiveError(code);
  }
}
