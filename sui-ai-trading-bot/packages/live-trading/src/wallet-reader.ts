import type { SuiGrpcClient } from "@mysten/sui/grpc";
import type { SuiClientTypes } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";
import { coin, SUI, USDC, bounded } from "../../shared/src/index.ts";
import { address, requireLive, validateWallet } from "./policy.ts";
import type {
  WalletReader,
  LivePolicy,
  WalletSnapshot,
  OwnedCoin,
  SharedInput,
} from "./types.ts";
type ReadApi = Pick<
  SuiGrpcClient,
  "getChainIdentifier" | "getBalance" | "listCoins" | "getReferenceGasPrice"
> & {
  getObjects(request: {
    objectIds: string[];
  }): Promise<SuiClientTypes.GetObjectsResponse<{}>>;
};
export class GrpcWalletReader implements WalletReader {
  constructor(private client: ReadApi) {}
  async read(wallet: string, policy: LivePolicy): Promise<WalletSnapshot> {
    const owner = address(wallet),
      started = Date.now();
    const [chain, sui, usdc, gasPrice, objects] = await bounded(() =>
      Promise.all([
        this.client.getChainIdentifier(),
        this.client.getBalance({ owner, coinType: SUI }),
        this.client.getBalance({ owner, coinType: USDC }),
        this.client.getReferenceGasPrice(),
        this.client.getObjects({
          objectIds: [
            policy.globalConfig,
            policy.partner,
            policy.clock,
            policy.pool,
          ].map((x) => x.objectId),
        }),
      ]),
    );
    requireLive(
      coin(sui.balance.coinType) === SUI &&
        coin(usdc.balance.coinType) === USDC,
      "INVALID_BALANCE_RESPONSE",
    );
    const coins: OwnedCoin[] = [];
    for (const type of [SUI, USDC]) {
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        requireLive(++pages <= 20, "COIN_PAGE_LIMIT");
        const result = await bounded(() =>
          this.client.listCoins({ owner, coinType: type, cursor, limit: 100 }),
        );
        for (const c of result.objects) {
          requireLive(
            c.owner.$kind === "AddressOwner" &&
              address(c.owner.AddressOwner) === owner,
            "INVALID_COIN_OWNER",
          );
          requireLive(
            normalizeStructTag(c.type) ===
              normalizeStructTag(`0x2::coin::Coin<${type}>`),
            "UNEXPECTED_COIN_TYPE",
          );
          coins.push({
            objectId: c.objectId,
            version: c.version,
            digest: c.digest,
            coinType: type,
            balance: c.balance,
          });
        }
        cursor = result.cursor;
      } while (cursor);
    }
    const manifest = [
      policy.globalConfig,
      policy.partner,
      policy.clock,
      policy.pool,
    ];
    const shared: SharedInput[] = objects.objects.map((object, i) => {
      requireLive(
        !(object instanceof Error) && object.owner.$kind === "Shared",
        "INVALID_SHARED_OBJECT",
      );
      return {
        objectId: object.objectId,
        initialSharedVersion: object.owner.Shared!.initialSharedVersion,
        type: object.type,
        mutable: manifest[i].mutable,
      };
    });
    const snapshot = {
      address: owner,
      chainIdentifier: chain.chainIdentifier,
      observedAt: started,
      sui: sui.balance.balance,
      usdc: usdc.balance.balance,
      coins,
      gasPrice: gasPrice.referenceGasPrice,
      objects: shared,
    };
    validateWallet(snapshot, policy, Date.now());
    return snapshot;
  }
}
