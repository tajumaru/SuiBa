import "dotenv/config";

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { deepbook } from "@mysten/deepbook-v3";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { GrpcWebFetchTransport, SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";
import { isMainModule } from "./is-main-module.ts";

export type SwapTarget = "DBUSDC" | "DEEP";
export interface SwapPlan {
  target: SwapTarget;
  poolKey: "SUI_DBUSDC" | "DEEP_SUI";
  direction: "BASE_TO_QUOTE" | "QUOTE_TO_BASE";
  amountSui: number;
  quotedOut: number;
  minOut: number;
  deepRequired: number;
  feeMode: "INPUT_TOKEN";
}

const positive = (
  value: string | undefined,
  name: string,
  fallback?: number,
) => {
  const parsed =
    value === undefined && fallback !== undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw Error(`${name}_INVALID`);
  return parsed;
};

export function minOutFromQuote(
  quotedOut: number,
  slippageBps: number,
  decimals = 6,
) {
  if (
    !(quotedOut > 0) ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 1_000
  )
    throw Error("REAL_SWAP_GUARD_INVALID");
  const scalar = 10 ** decimals;
  return Math.floor(quotedOut * (1 - slippageBps / 10_000) * scalar) / scalar;
}

export function swapRoute(target: SwapTarget) {
  return target === "DBUSDC"
    ? { poolKey: "SUI_DBUSDC" as const, direction: "BASE_TO_QUOTE" as const }
    : { poolKey: "DEEP_SUI" as const, direction: "QUOTE_TO_BASE" as const };
}

export function swapStopState(path: string | undefined) {
  if (!path || !existsSync(path)) return "no-database" as const;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    try {
      const row = db
        .prepare(
          "SELECT halted,generation FROM real_control ORDER BY rowid DESC LIMIT 1",
        )
        .get() as { halted: number; generation: number } | undefined;
      return row
        ? { halted: Boolean(row.halted), generation: row.generation }
        : ("no-database" as const);
    } catch {
      return "no-database" as const;
    }
  } finally {
    db.close();
  }
}

export async function runSwap(
  env: NodeJS.ProcessEnv,
  argv: string[],
  deps?: {
    quote(
      target: SwapTarget,
      amount: number,
    ): Promise<{ out: number; deepRequired: number }>;
    execute(plan: SwapPlan): Promise<string>;
    output(value: unknown): void;
  },
) {
  const execute = argv.includes("--execute");
  const targetArg = argv
    .find((arg) => arg.startsWith("--target="))
    ?.split("=")[1];
  if (targetArg !== "DBUSDC" && targetArg !== "DEEP")
    throw Error("REAL_SWAP_TARGET_REQUIRED");
  const target = targetArg;
  const amountSui = positive(env.REAL_SWAP_AMOUNT_SUI, "REAL_SWAP_AMOUNT_SUI");
  const maxSui = positive(env.REAL_SWAP_MAX_SUI, "REAL_SWAP_MAX_SUI", 10);
  if (amountSui > maxSui) throw Error("REAL_SWAP_AMOUNT_EXCEEDS_MAX");
  const slippageBps = Number(env.REAL_SWAP_SLIPPAGE_BPS ?? "50");

  let runtime = deps;
  if (!runtime) {
    const key = env.REAL_BOT_PRIVATE_KEY;
    if (execute && !key) throw Error("REAL_BOT_PRIVATE_KEY_REQUIRED");
    const keypair = key ? Ed25519Keypair.fromSecretKey(key) : null;
    const address = keypair?.toSuiAddress() ?? env.REAL_SIGNER_ADDRESS;
    if (!address) throw Error("REAL_SIGNER_ADDRESS_REQUIRED");
    if (
      keypair &&
      env.REAL_SIGNER_ADDRESS &&
      address !== env.REAL_SIGNER_ADDRESS
    )
      throw Error("REAL_SIGNER_IDENTITY_MISMATCH");
    const client = new SuiGrpcClient({
      network: "testnet",
      transport: new GrpcWebFetchTransport({
        baseUrl: env.REAL_SUI_GRPC_URL ?? "https://fullnode.testnet.sui.io:443",
      }),
    });
    const sdk = client.$extend(deepbook({ address }));
    runtime = {
      async quote(coin, amount) {
        const result =
          coin === "DBUSDC"
            ? await sdk.deepbook.getQuoteQuantityOut("SUI_DBUSDC", amount)
            : await sdk.deepbook.getBaseQuantityOut("DEEP_SUI", amount);
        return {
          out: Number(coin === "DBUSDC" ? result.quoteOut : result.baseOut),
          deepRequired: Number(result.deepRequired),
        };
      },
      async execute(plan) {
        const tx = new Transaction();
        tx.setSender(address);
        const outputs =
          plan.direction === "BASE_TO_QUOTE"
            ? tx.add(
                sdk.deepbook.deepBook.swapExactBaseForQuote({
                  poolKey: plan.poolKey,
                  amount: plan.amountSui,
                  deepAmount: 0,
                  minOut: plan.minOut,
                }),
              )
            : tx.add(
                sdk.deepbook.deepBook.swapExactQuoteForBase({
                  poolKey: plan.poolKey,
                  amount: plan.amountSui,
                  deepAmount: 0,
                  minOut: plan.minOut,
                }),
              );
        tx.transferObjects([...outputs], address);
        const bytes = await tx.build({ client });
        const digest = await tx.getDigest({ client });
        const evidencePath =
          env.REAL_SWAP_EVIDENCE_PATH ?? "data/real-swap-evidence.jsonl";
        mkdirSync(dirname(evidencePath), { recursive: true });
        appendFileSync(
          evidencePath,
          `${JSON.stringify({
            state: "SUBMITTING",
            digest,
            txBytesHash: createHash("sha256").update(bytes).digest("hex"),
            network: "testnet",
            address,
            target: plan.target,
            poolKey: plan.poolKey,
            amountSui: plan.amountSui,
            minOut: plan.minOut,
            persistedAt: Date.now(),
            realControl: swapStopState(env.REAL_DATABASE_PATH),
          })}\n`,
          { encoding: "utf8", flush: true },
        );
        if (!keypair) throw Error("REAL_BOT_PRIVATE_KEY_REQUIRED");
        const signature = (await keypair.signTransaction(bytes)).signature;
        const submitted = await client.executeTransaction({
          transaction: bytes,
          signatures: [signature],
        });
        const actual = (submitted.Transaction ?? submitted.FailedTransaction)
          ?.digest;
        if (!actual || actual !== digest)
          throw Error("REAL_SWAP_DIGEST_MISMATCH");
        appendFileSync(
          evidencePath,
          `${JSON.stringify({ state: "SENT", digest, sentAt: Date.now() })}\n`,
          { encoding: "utf8", flush: true },
        );
        return digest;
      },
      output: console.info,
    };
  }
  const quote = await runtime.quote(target, amountSui);
  const plan: SwapPlan = {
    target,
    ...swapRoute(target),
    amountSui,
    quotedOut: quote.out,
    minOut: minOutFromQuote(quote.out, slippageBps),
    deepRequired: quote.deepRequired,
    feeMode: "INPUT_TOKEN",
  };
  runtime.output({
    mode: execute ? "EXECUTE" : "DRY_RUN",
    network: "testnet",
    slippageBps,
    ...plan,
  });
  if (!execute) return { plan, digest: null };
  const digest = await runtime.execute(plan);
  runtime.output({ state: "SENT", digest });
  return { plan, digest };
}

if (isMainModule(import.meta.url, process.argv[1]))
  await runSwap(process.env, process.argv.slice(2));
