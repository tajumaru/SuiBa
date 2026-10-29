import {
  SessionsContract,
  getSessionsConfig,
  getDeployment,
  MAX_SESSION_DURATION_MS,
  MAX_SESSIONS_PER_ACCOUNT,
} from "@mysten/deepbook-v3/sessions";
import { Transaction } from "@mysten/sui/transactions";

const functions = Object.freeze({
  authorize: "authorize_session",
  revoke: "revoke_session",
  expiry: "session_expiration_ms",
});
const ids = getSessionsConfig("testnet");
const contract = new SessionsContract(ids);
export function assertTestnet(network) {
  if (network !== "testnet") throw Error("TESTNET_ONLY");
}
function address(value) {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(value) ||
    /^0x0{64}$/.test(value)
  )
    throw Error("INVALID_PUBLIC_ADDRESS");
  return value.toLowerCase();
}
function duration(value) {
  let ms;
  if (typeof value === "bigint") ms = value;
  else if (typeof value === "number" && Number.isSafeInteger(value))
    ms = BigInt(value);
  else if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value))
    ms = BigInt(value);
  else throw Error("INVALID_DURATION");
  if (ms <= 0n || ms > BigInt(MAX_SESSION_DURATION_MS))
    throw Error("DURATION_OUT_OF_RANGE");
  return ms;
}
export function plan() {
  return {
    schema: 1,
    stage: "OFFLINE_PTB_BLUEPRINT",
    network: "testnet",
    networkRequests: 0,
    signed: false,
    submitted: false,
    onchainVerified: false,
    sdk: { deepbook: "2.8.0", sui: "2.37.0" },
    deployment: getDeployment("testnet"),
    actions: Object.keys(functions),
    maxSessionDurationMs: MAX_SESSION_DURATION_MS,
    maxSessionsPerAccount: MAX_SESSIONS_PER_ACCOUNT,
    note: "Public addresses only. No signer, endpoint, key store, simulation, or transaction execution.",
  };
}
export function validateBlueprint(data, action, owner) {
  if (!Object.hasOwn(functions, action)) throw Error("UNKNOWN_ACTION");
  const call = data.commands?.[0]?.MoveCall;
  if (
    data.sender !== owner ||
    data.commands?.length !== 1 ||
    call?.package !== ids.sessionsPackageId ||
    call.module !== "sessions" ||
    call.function !== functions[action] ||
    call.typeArguments.length !== 0
  )
    throw Error("UNEXPECTED_PTB_COMMAND");
  if (Object.values(data.gasData).some((v) => v !== null))
    throw Error("UNEXPECTED_GAS_CONFIGURATION");
  const allowed = new Set([
    contract.deriveAccountWrapperId(owner),
    ids.sessionsConfig,
    "0x" + "0".repeat(63) + "6",
  ]);
  for (const input of data.inputs) {
    if (input.UnresolvedObject && !allowed.has(input.UnresolvedObject.objectId))
      throw Error("UNEXPECTED_PTB_INPUT");
    if (
      input.Object &&
      (input.Object.SharedObject?.objectId !== "0x" + "0".repeat(63) + "6" ||
        input.Object.SharedObject.mutable !== false)
    )
      throw Error("UNEXPECTED_PTB_INPUT");
  }
}
export function buildBlueprint(options) {
  const allowed = ["action", "network", "owner", "session", "durationMs"];
  if (!options || Object.keys(options).some((k) => !allowed.includes(k)))
    throw Error("UNKNOWN_INPUT");
  const { action, network = "testnet" } = options;
  assertTestnet(network);
  if (!Object.hasOwn(functions, action)) throw Error("UNKNOWN_ACTION");
  const owner = address(options.owner),
    session = address(options.session);
  if (owner === session) throw Error("DISTINCT_SESSION_ADDRESS_REQUIRED");
  if (action !== "authorize" && options.durationMs !== undefined)
    throw Error("DURATION_ONLY_FOR_AUTHORIZE");
  const durationMs =
    action === "authorize" ? duration(options.durationMs ?? 300000) : null;
  const wrapperId = contract.deriveAccountWrapperId(owner);
  const tx = new Transaction();
  tx.setSender(owner);
  const params = { wrapperId, session };
  if (action === "authorize")
    tx.add(contract.authorizeSession({ ...params, durationMs }));
  else if (action === "revoke") tx.add(contract.revokeSession(params));
  else tx.add(contract.sessionExpirationMs(params));
  // getData preserves unresolved objects: no network object/gas resolution or build().
  const transaction = tx.getData();
  validateBlueprint(transaction, action, owner);
  return {
    ...plan(),
    action,
    owner,
    session,
    durationMs: durationMs?.toString() ?? null,
    wrapperId,
    accountId: contract.deriveAccountId(owner),
    sessionsFieldId: contract.deriveSessionsFieldId(owner),
    transaction,
    limitations: [
      "Unsigned/unresolved blueprint, not a simulated or executable transaction.",
      "Account ownership/existence, registry authorization, grant capacity and expiry need Testnet verification.",
      "A session grants account-wide trading authority; no per-pool/notional/loss cap is proven.",
    ],
  };
}
