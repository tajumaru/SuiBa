import { apiFetch } from "../../shared/src/api.ts";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidSuiAddress, isValidTransactionDigest } from "@mysten/sui/utils";
import { coin, decimals, SUI, USDC } from "../../shared/src/index.ts";
export class ReadOnlySuiClient {
  private client: SuiGrpcClient;
  status: { healthy: boolean; checkedAt: number; failures: number } = {
    healthy: false,
    checkedAt: 0,
    failures: 0,
  };
  constructor(url = "https://fullnode.mainnet.sui.io:443") {
    if (new URL(url).protocol !== "https:") throw new Error("HTTPS_REQUIRED");
    this.client = new SuiGrpcClient({
      network: "mainnet",
      baseUrl: url,
      fetch: (input, init) => apiFetch("Sui gRPC", input, init),
    });
  }
  private async read<T>(fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      this.status = { healthy: true, checkedAt: Date.now(), failures: 0 };
      return r;
    } catch {
      this.status = {
        healthy: false,
        checkedAt: Date.now(),
        failures: this.status.failures + 1,
      };
      throw new Error("SUI_READ_FAILED");
    }
  }

  async balance(owner: string, type: string) {
    if (!isValidSuiAddress(owner)) throw new Error("INVALID_ADDRESS");
    const t = coin(type);
    return this.read(async () => {
      const { balance } = await this.client.getBalance({ owner, coinType: t });
      if (coin(balance.coinType) !== t || !/^\d+$/.test(balance.balance))
        throw new Error("INVALID_BALANCE");
      return { coinType: t, atomic: balance.balance, decimals: decimals(t) };
    });
  }
  async metadata(type: string) {
    const t = coin(type);
    return this.read(async () => {
      const { coinMetadata } = await this.client.getCoinMetadata({
        coinType: t,
      });
      if (!coinMetadata || coinMetadata.decimals !== decimals(t))
        throw new Error("INVALID_METADATA");
      return { coinType: t, ...coinMetadata };
    });
  }
  async transaction(digest: string) {
    if (!isValidTransactionDigest(digest)) throw new Error("INVALID_DIGEST");
    return this.read(async () => {
      const r = await this.client.getTransaction({
        digest,
        include: { effects: true },
      });
      const tx = r.Transaction ?? r.FailedTransaction;
      if (!tx || tx.digest !== digest) throw new Error("INVALID_TRANSACTION");
      return r;
    });
  }
  async health(force = false) {
    if (
      !force &&
      this.status.healthy &&
      Date.now() - this.status.checkedAt < 120000
    )
      return this.status;
    const results = await Promise.allSettled([
      this.metadata(SUI),
      this.metadata(USDC),
    ]);
    if (results.some((r) => r.status === "rejected")) {
      this.status = {
        healthy: false,
        checkedAt: Date.now(),
        failures: this.status.failures + 1,
      };
      throw new Error("SUI_READ_FAILED");
    }
    this.status = { healthy: true, checkedAt: Date.now(), failures: 0 };
    return this.status;
  }
}
