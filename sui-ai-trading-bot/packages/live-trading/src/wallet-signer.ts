import { address, requireLive, LiveError } from "./policy.ts";
/** KMS-compatible abstraction. No implementation in this phase can produce a signature. */
export interface WalletSigner {
  getAddress(): Promise<string>;
  signTransaction(
    bytes: Uint8Array,
  ): Promise<{ bytes: string; signature: string }>;
}
export async function loadWalletSigner(
  options: {
    mode: "PAPER" | "LIVE";
    previewEnabled: boolean;
    allowedAddress: string;
  },
  readSecret: () => Promise<string | undefined>,
): Promise<WalletSigner | undefined> {
  if (options.mode === "PAPER") return undefined;
  requireLive(options.previewEnabled, "LIVE_DISABLED");
  const allowed = address(options.allowedAddress);
  await verifyAddress(allowed, readSecret);
  // Capture only the allowlisted address and secret provider, never a key or mutable options.
  return Object.freeze({
    getAddress: () => verifyAddress(allowed, readSecret),
    signTransaction: async () => {
      throw new LiveError("SIGNING_DISABLED_PHASE_1_3");
    },
  });
}
async function verifyAddress(
  allowed: string,
  readSecret: () => Promise<string | undefined>,
): Promise<string> {
  let secret: string | undefined;
  try {
    secret = await readSecret();
  } catch {
    throw new LiveError("SECRET_UNAVAILABLE");
  }
  requireLive(secret, "SECRET_NOT_CONFIGURED");
  let derived: string;
  try {
    const { Ed25519Keypair } = await import("@mysten/sui/keypairs/ed25519");
    const key = Ed25519Keypair.fromSecretKey(secret);
    derived = key.toSuiAddress();
  } catch {
    throw new LiveError("INVALID_SECRET");
  } finally {
    secret = undefined;
  }
  requireLive(address(derived) === allowed, "WALLET_CHANGED");
  // Key object is deliberately not retained. A fresh source read also detects rotation.
  return allowed;
}
export class PreviewWalletSigner implements WalletSigner {
  constructor(private readonly wallet: string) {
    address(wallet);
  }
  async getAddress() {
    return address(this.wallet);
  }
  async signTransaction(_bytes: Uint8Array): Promise<never> {
    throw new LiveError("SIGNING_DISABLED_PHASE_1_3");
  }
}
