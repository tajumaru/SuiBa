import { deepbook } from "@mysten/deepbook-v3";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";

const key = process.env.REAL_OWNER_PRIVATE_KEY;
const action = process.argv[2];
if (!key) throw Error("REAL_OWNER_PRIVATE_KEY_REQUIRED");
if (!action) throw Error("OWNER_ACTION_REQUIRED");
const signer = Ed25519Keypair.fromSecretKey(key);
const owner = signer.toSuiAddress();
const manager = process.env.REAL_BALANCE_MANAGER_ID;
const bot = process.env.REAL_BOT_ADDRESS;
const cap = process.env.REAL_TRADE_CAP_ID;
const grpc =
  process.env.REAL_SUI_GRPC_URL ?? "https://fullnode.testnet.sui.io:443";
const client = new SuiGrpcClient({
  network: "testnet",
  transport: new GrpcWebFetchTransport({ baseUrl: grpc }),
});
const balanceManagers = manager ? { PHASE1: { address: manager } } : undefined;
const sdk = client.$extend(deepbook({ address: owner, balanceManagers }));
const tx = new Transaction();
tx.setSender(owner);
const amount = (name: string) => {
  const value = Number(process.env[name]);
  if (!(value > 0)) throw Error(`${name}_REQUIRED`);
  return value;
};
switch (action) {
  case "create-manager":
    tx.add(sdk.deepbook.balanceManager.createAndShareBalanceManager());
    break;
  case "deposit-sui":
    tx.add(
      sdk.deepbook.balanceManager.depositIntoManager(
        "PHASE1",
        "SUI",
        amount("REAL_AMOUNT"),
      ),
    );
    break;
  case "deposit-dbusdc":
    tx.add(
      sdk.deepbook.balanceManager.depositIntoManager(
        "PHASE1",
        "DBUSDC",
        amount("REAL_AMOUNT"),
      ),
    );
    break;
  case "deposit-deep":
    tx.add(
      sdk.deepbook.balanceManager.depositIntoManager(
        "PHASE1",
        "DEEP",
        amount("REAL_AMOUNT"),
      ),
    );
    break;
  case "mint-trade-cap": {
    if (!bot) throw Error("REAL_BOT_ADDRESS_REQUIRED");
    const minted = tx.add(sdk.deepbook.balanceManager.mintTradeCap("PHASE1"));
    tx.transferObjects([minted], bot);
    break;
  }
  case "revoke-trade-cap":
    if (!cap) throw Error("REAL_TRADE_CAP_ID_REQUIRED");
    else tx.add(sdk.deepbook.balanceManager.revokeTradeCap("PHASE1", cap));
    break;
  case "cancel-all":
    tx.add(sdk.deepbook.deepBook.cancelAllOrders("SUI_DBUSDC", "PHASE1"));
    break;
  case "withdraw-all":
    for (const coin of ["SUI", "DBUSDC", "DEEP"])
      tx.add(
        sdk.deepbook.balanceManager.withdrawAllFromManager(
          "PHASE1",
          coin,
          owner,
        ),
      );
    break;
  default:
    throw Error("OWNER_ACTION_INVALID");
}
const result = await signer.signAndExecuteTransaction({
  transaction: tx,
  client,
});
console.info(
  JSON.stringify({ action, digest: result.transaction?.digest ?? null, owner }),
);
