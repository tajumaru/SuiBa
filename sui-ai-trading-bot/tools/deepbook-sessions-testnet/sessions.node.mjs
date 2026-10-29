import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getSessionsConfig,
  MAX_SESSION_DURATION_MS,
} from "@mysten/deepbook-v3/sessions";
import { buildBlueprint, plan, validateBlueprint } from "./sessions.mjs";
import { parseArgs } from "./cli.mjs";
const owner = "0x" + "11".repeat(32),
  session = "0x" + "22".repeat(32);
const options = { network: "testnet", owner, session };
function pureArgument(data, index) {
  const arg = data.commands[0].MoveCall.arguments[index];
  return Buffer.from(data.inputs[arg.Input].Pure.bytes, "base64");
}
test("latest official Sessions SDK builds an unsigned Testnet authorize blueprint with exact BCS inputs", () => {
  const p = buildBlueprint({
    ...options,
    action: "authorize",
    durationMs: 300000,
  });
  assert.equal(p.transaction.sender, owner);
  assert.equal(p.transaction.commands.length, 1);
  assert.equal(
    p.transaction.commands[0].MoveCall.package,
    getSessionsConfig("testnet").sessionsPackageId,
  );
  assert.equal(
    p.transaction.commands[0].MoveCall.function,
    "authorize_session",
  );
  assert.equal(
    pureArgument(p.transaction, 2).toString("hex"),
    session.slice(2),
  );
  assert.equal(pureArgument(p.transaction, 3).readBigUInt64LE(), 300000n);
  assert.equal(p.submitted, false);
  assert.equal(p.signed, false);
  assert.equal(p.onchainVerified, false);
  assert.equal(p.deployment.chainId, "4c78adac");
  assert.notEqual(p.wrapperId, p.accountId);
  assert.deepEqual(p.transaction.gasData, {
    budget: null,
    price: null,
    owner: null,
    payment: null,
  });
});
test("revoke and expiry use distinct lifecycle calls and deterministic wrapper/account/field derivation", () => {
  const revoke = buildBlueprint({ ...options, action: "revoke" }),
    expiry = buildBlueprint({ ...options, action: "expiry" });
  assert.equal(
    revoke.transaction.commands[0].MoveCall.function,
    "revoke_session",
  );
  assert.equal(
    expiry.transaction.commands[0].MoveCall.function,
    "session_expiration_ms",
  );
  assert.equal(revoke.wrapperId, expiry.wrapperId);
  assert.equal(revoke.sessionsFieldId, expiry.sessionsFieldId);
  assert.equal(expiry.durationMs, null);
});
test("non-Testnet networks and endpoint/key inputs are rejected before building", () => {
  for (const network of [
    "mainnet",
    "devnet",
    "localnet",
    "https://fullnode.mainnet.sui.io",
    null,
  ])
    assert.throws(
      () => buildBlueprint({ ...options, network, action: "authorize" }),
      /TESTNET_ONLY/,
    );
  for (const extra of [
    { privateKey: "dummy-test-value" },
    { rpcUrl: "https://example.invalid" },
    { client: {} },
  ])
    assert.throws(
      () => buildBlueprint({ ...options, ...extra, action: "authorize" }),
      /UNKNOWN_INPUT/,
    );
});
test("invalid public addresses, owner-as-session, unsupported actions and durations never produce a blueprint", () => {
  for (const address of [
    "0x1",
    "0x" + "0".repeat(64),
    "suiprivkey-dummy",
    undefined,
  ])
    assert.throws(
      () => buildBlueprint({ ...options, owner: address, action: "authorize" }),
      /PUBLIC_ADDRESS/,
    );
  assert.throws(
    () => buildBlueprint({ ...options, session: owner, action: "authorize" }),
    /DISTINCT/,
  );
  assert.throws(
    () => buildBlueprint({ ...options, action: "placeMarketOrder" }),
    /UNKNOWN_ACTION/,
  );
  for (const durationMs of [
    0,
    -1,
    NaN,
    Infinity,
    1.5,
    MAX_SESSION_DURATION_MS + 1,
    "9007199254740993",
  ])
    assert.throws(
      () => buildBlueprint({ ...options, action: "authorize", durationMs }),
      /DURATION/,
    );
  for (const durationMs of [1, MAX_SESSION_DURATION_MS, 300000n, "300000"])
    assert.doesNotThrow(() =>
      buildBlueprint({ ...options, action: "authorize", durationMs }),
    );
  assert.throws(
    () => buildBlueprint({ ...options, action: "revoke", durationMs: 1 }),
    /DURATION_ONLY/,
  );
});
test("a mainnet call target or unexpected object cannot be labeled a valid Testnet blueprint", () => {
  const p = buildBlueprint({ ...options, action: "authorize" }),
    data = structuredClone(p.transaction);
  data.commands[0].MoveCall.package =
    getSessionsConfig("mainnet").sessionsPackageId;
  assert.throws(
    () => validateBlueprint(data, "authorize", owner),
    /UNEXPECTED_PTB_COMMAND/,
  );
  const other = structuredClone(p.transaction);
  other.inputs[0].UnresolvedObject.objectId = "0x" + "33".repeat(32);
  assert.throws(
    () => validateBlueprint(other, "authorize", owner),
    /UNEXPECTED_PTB_INPUT/,
  );
});
test("CLI rejects signing/execution flags, duplicates and ambiguous input", () => {
  for (const argv of [
    ["--private-key", "dummy"],
    ["--execute"],
    ["--network", "testnet", "--network", "mainnet"],
    ["--owner"],
  ])
    assert.throws(() => parseArgs(argv), /ARGUMENT/);
});
test("default and PTB CLI commands work with networking blocked and no credentials/environment config", () => {
  const guard = `import net from 'node:net';import dns from 'node:dns';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';import http2 from 'node:http2';import {syncBuiltinESMExports} from 'node:module';
    const fail=()=>{throw Error('NETWORK_FORBIDDEN');};globalThis.fetch=fail;net.connect=net.createConnection=dns.lookup=dns.resolve=dns.promises.lookup=tls.connect=http.request=https.request=http2.connect=fail;syncBuiltinESMExports();`;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) =>
      ["systemroot", "windir", "path", "temp", "tmp"].includes(k.toLowerCase()),
    ),
  );
  for (const args of [
    [],
    ["--action", "authorize", "--owner", owner, "--session", session],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "data:text/javascript," + encodeURIComponent(guard),
        fileURLToPath(new URL("cli.mjs", import.meta.url)),
        ...args,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, result.stderr);
    const p = JSON.parse(result.stdout);
    assert.equal(p.network, "testnet");
    assert.equal(p.networkRequests, 0);
    assert.equal(p.submitted, false);
  }
  assert.equal(plan().maxSessionsPerAccount, 20);
});
