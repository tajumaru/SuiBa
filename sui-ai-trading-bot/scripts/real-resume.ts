import "dotenv/config";

import { realConfigFromEnv } from "../apps/worker/src/real/config.ts";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import { IndexerGraphqlHistorySource } from "../apps/worker/src/real/history-source.ts";
import { RealReconciler } from "../apps/worker/src/real/reconciler.ts";
import { createDeepBookReadOnly } from "../apps/worker/src/real/read-only.ts";
import { tradeCapValid } from "../apps/worker/src/real/cap-valid.ts";
import { isMainModule } from "./is-main-module.ts";
import type {
  RealHistoryEvent,
  RealIdentity,
} from "../apps/worker/src/real/types.ts";

// Sui framework SUI and DeepBook testnet DEEP use 9 decimals; DBUSDC uses 6.
// These are Phase 1 comparison constants and must match on-chain metadata.
export const PHASE1_DECIMALS = { SUI: 9, DBUSDC: 6, DEEP: 9 } as const;
export const ENGINE_CHECKS_MAX_AGE_MS = 2 * 60 * 1000;
type Asset = keyof typeof PHASE1_DECIMALS;
const atomic = (value: unknown, decimals: number) => {
  const text = String(value ?? "0");
  if (!/^\d+(\.\d+)?$/.test(text)) throw Error("REAL_BALANCE_INVALID");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > decimals) throw Error("REAL_BALANCE_PRECISION_INVALID");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"))
  );
};

export function balanceEvidence(
  rows: Array<Record<string, string>>,
  snapshot: {
    balances: Record<Asset, unknown>;
    locked: Partial<Record<Asset, unknown>>;
    settledUnclaimed: Partial<Record<Asset, unknown>>;
    botGasSuiMist: string;
    decimals?: Partial<Record<Asset, number>>;
  },
) {
  const differences: Record<string, string> = {};
  let validDecimals = true;
  for (const asset of Object.keys(PHASE1_DECIMALS) as Asset[]) {
    if (
      snapshot.decimals?.[asset] !== undefined &&
      snapshot.decimals[asset] !== PHASE1_DECIMALS[asset]
    )
      validDecimals = false;
    const row = rows.find((candidate) => candidate.asset === asset) ?? {};
    const expected = {
      available: BigInt(row.availableAtomic ?? "0"),
      locked: BigInt(row.orderLockedAtomic ?? "0"),
      settled: BigInt(row.settledUnclaimedAtomic ?? "0"),
      fee: BigInt(row.feeAtomic ?? "0"),
      gas: BigInt(row.gasMist ?? "0"),
    };
    const actual = {
      available: atomic(snapshot.balances[asset], PHASE1_DECIMALS[asset]),
      locked: atomic(snapshot.locked[asset] ?? 0, PHASE1_DECIMALS[asset]),
      settled: atomic(
        snapshot.settledUnclaimed[asset] ?? 0,
        PHASE1_DECIMALS[asset],
      ),
      fee: 0n,
      gas: asset === "SUI" ? BigInt(snapshot.botGasSuiMist) : 0n,
    };
    for (const key of Object.keys(expected) as Array<keyof typeof expected>)
      differences[`${asset}.${key}`] = (actual[key] - expected[key]).toString();
  }
  return {
    explained:
      validDecimals &&
      Object.values(differences).every((value) => value === "0"),
    validDecimals,
    differences,
  };
}

export interface ResumeDependencies {
  db: RealTradeCapDatabase;
  identity: RealIdentity;
  reconcile(): Promise<{ pages: number; events: number; nextCursor: null }>;
  snapshot(): Promise<{
    balances: Record<Asset, unknown>;
    openOrderIds: unknown[];
    locked: Partial<Record<Asset, unknown>>;
    settledUnclaimed: Partial<Record<Asset, unknown>>;
    botGasSuiMist: string;
    decimals?: Partial<Record<Asset, number>>;
  }>;
  capValid(): Promise<boolean>;
  engineChecks(): Promise<{
    riskAllowed: boolean;
    profitGuardAllowed: boolean;
    marketHealthy: boolean;
  }>;
}

export function readEngineChecks(
  db: RealTradeCapDatabase,
  identity: RealIdentity,
  now = Date.now(),
) {
  const denied = {
    riskAllowed: false,
    profitGuardAllowed: false,
    marketHealthy: false,
  };
  const record = db.latestEngineChecks(identity);
  if (
    !record ||
    JSON.stringify(record.identity) !== JSON.stringify(identity) ||
    !Number.isFinite(record.recordedAt) ||
    record.recordedAt > now ||
    now - record.recordedAt > ENGINE_CHECKS_MAX_AGE_MS
  )
    return denied;
  return {
    riskAllowed: record.risk === "ALLOWED",
    profitGuardAllowed: record.profitGuard === "ALLOWED",
    marketHealthy: record.market === "HEALTHY",
  };
}

export async function resumeReal(
  deps: ResumeDependencies,
  options: {
    approve: boolean;
    ownerApproval?: string;
    minBotGasSui?: number;
    minDeep?: number;
  },
) {
  if (
    deps.db.latchInfo(deps.identity, "REAL_UNIDENTIFIABLE_PREDECESSOR")
      ?.permanent
  )
    throw Error("REAL_UNIDENTIFIABLE_PREDECESSOR");
  const reconciliation = await deps.reconcile();
  const before = deps.db.ledgerCount();
  const events = deps.db.ledgerEvents(deps.identity);
  const checkpoint = deps.db.checkpoint();
  if (checkpoint)
    deps.db.applyPage(deps.identity, events as RealHistoryEvent[], checkpoint);
  const ledgerIdempotent = deps.db.ledgerCount() === before;
  const snapshot = await deps.snapshot();
  const balances = balanceEvidence(
    deps.db.balanceLedger(deps.identity),
    snapshot,
  );
  const engine = await deps.engineChecks();
  const minGas = options.minBotGasSui;
  const minDeep = options.minDeep;
  const checks = {
    allTransactionsTerminal: !deps.db.hasNonTerminalSubmission(deps.identity),
    historyComplete: reconciliation.nextCursor === null,
    ledgerIdempotent,
    balancesExplained: balances.explained,
    noOpenOrders: snapshot.openOrderIds.length === 0,
    identityMatches: deps.db.identityRegistered(deps.identity),
    capValid: await deps.capValid(),
    gasSufficient:
      minGas === undefined
        ? BigInt(snapshot.botGasSuiMist) > 0n
        : atomic(String(minGas), PHASE1_DECIMALS.SUI) <=
          BigInt(snapshot.botGasSuiMist),
    deepSufficient:
      minDeep === undefined
        ? Number(snapshot.balances.DEEP) > 0
        : Number(snapshot.balances.DEEP) >= minDeep,
    ...engine,
  };
  let opened = false;
  if (options.approve) {
    if (!options.ownerApproval) throw Error("REAL_OWNER_APPROVAL_REQUIRED");
    if (Object.values(checks).every(Boolean) && checkpoint) {
      deps.db.approveResume(deps.identity, {
        checkpoint: checkpoint.checkpoint,
        checkpointHash: checkpoint.checkpointHash,
        identityKey: deps.db.identityKey(deps.identity),
        ownerApproval: options.ownerApproval,
      });
      deps.db.openSigningGate(deps.identity, checks);
      opened = true;
    }
  }
  return { checks, evidence: { reconciliation, balances }, opened };
}

export async function runResume(env: NodeJS.ProcessEnv, argv: string[]) {
  const { path, config } = realConfigFromEnv(env);
  const identity: RealIdentity = {
    network: config.network,
    balanceManagerId: config.balanceManagerId,
    poolKey: config.poolKey,
    tradeCapId: config.tradeCapId,
    signerAddress: config.signerAddress,
    sessionId: config.sessionId,
  };
  const db = new RealTradeCapDatabase(path);
  db.registerIdentity(identity);
  const source = new IndexerGraphqlHistorySource(
    config.indexerUrl,
    config.graphqlUrl,
    identity,
    db.checkpoint(),
  );
  const reconciler = new RealReconciler(db, identity, source);
  const reader = createDeepBookReadOnly(config, config.grpcUrl);
  try {
    const result = await resumeReal(
      {
        db,
        identity,
        reconcile: () => reconciler.reconcileAllPages(),
        snapshot: async () => {
          const value = await reader.snapshot();
          return {
            ...value,
            locked: value.locked as Partial<Record<Asset, unknown>>,
            settledUnclaimed: value.settledUnclaimed as Partial<
              Record<Asset, unknown>
            >,
          };
        },
        capValid: () => tradeCapValid(config.graphqlUrl, identity),
        engineChecks: async () => readEngineChecks(db, identity),
      },
      {
        approve: argv.includes("--approve"),
        ownerApproval: argv
          .find((arg) => arg.startsWith("--reason="))
          ?.slice(9),
        minBotGasSui:
          env.REAL_MIN_BOT_GAS_SUI === undefined
            ? undefined
            : Number(env.REAL_MIN_BOT_GAS_SUI),
        minDeep:
          env.REAL_MIN_DEEP === undefined
            ? undefined
            : Number(env.REAL_MIN_DEEP),
      },
    );
    console.info(JSON.stringify(result));
    return result;
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url, process.argv[1]))
  await runResume(process.env, process.argv.slice(2));
