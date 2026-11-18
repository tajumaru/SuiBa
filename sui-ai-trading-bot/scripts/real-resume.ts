import "dotenv/config";

import { realConfigFromEnv } from "../apps/worker/src/real/config.ts";
import { RealTradeCapDatabase } from "../apps/worker/src/real/database.ts";
import { IndexerGraphqlHistorySource } from "../apps/worker/src/real/history-source.ts";
import { RealReconciler } from "../apps/worker/src/real/reconciler.ts";
import { createDeepBookReadOnly } from "../apps/worker/src/real/read-only.ts";
import {
  tradeCapEvidence,
  type TradeCapEvidence,
} from "../apps/worker/src/real/cap-valid.ts";
import { isMainModule } from "./is-main-module.ts";
import type {
  RealHistoryEvent,
  RealIdentity,
} from "../apps/worker/src/real/types.ts";

// Coin decimals used for Phase 1 ledger comparisons: SUI has 9; DBUSDC and
// DEEP have 6. DeepBook's internal DEEP scalar (1e9) is not the coin scalar.
export const PHASE1_DECIMALS = { SUI: 9, DBUSDC: 6, DEEP: 6 } as const;
export const ENGINE_CHECKS_MAX_AGE_MS = 2 * 60 * 1000;
type Asset = keyof typeof PHASE1_DECIMALS;
export const atomic = (value: number | string, decimals: number) => {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0)
      throw Error("REAL_BALANCE_INVALID");
    const scaled = value * 10 ** decimals;
    const rounded = Math.round(scaled);
    if (
      !Number.isSafeInteger(rounded) ||
      Math.abs(scaled - rounded) >
        Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8
    )
      throw Error("REAL_BALANCE_PRECISION_INVALID");
    return BigInt(rounded);
  }
  const text = value;
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
    owedBalances?: Partial<Record<Asset, unknown>>;
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
      owed: 0n,
      fee: BigInt(row.feeAtomic ?? "0"),
      gas: BigInt(row.gasMist ?? "0"),
    };
    const actual = {
      available: atomic(
        snapshot.balances[asset] as number | string,
        PHASE1_DECIMALS[asset],
      ),
      locked: atomic(
        (snapshot.locked[asset] ?? 0) as number | string,
        PHASE1_DECIMALS[asset],
      ),
      settled: atomic(
        (snapshot.settledUnclaimed[asset] ?? 0) as number | string,
        PHASE1_DECIMALS[asset],
      ),
      owed: atomic(
        (snapshot.owedBalances?.[asset] ?? 0) as number | string,
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
    owedBalances?: Partial<Record<Asset, unknown>>;
    botGasSuiMist: string;
    decimals?: Partial<Record<Asset, number>>;
  }>;
  capValid(): Promise<boolean | TradeCapEvidence>;
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
  const capResult = await deps.capValid();
  const cap =
    typeof capResult === "boolean"
      ? {
          valid: capResult,
          queryErrored: false,
          conjuncts: undefined,
        }
      : capResult;
  const minGasMist =
    minGas === undefined ? 1n : atomic(minGas, PHASE1_DECIMALS.SUI);
  const checks = {
    allTransactionsTerminal: !deps.db.hasNonTerminalSubmission(deps.identity),
    historyComplete: reconciliation.nextCursor === null,
    ledgerIdempotent,
    balancesExplained: balances.explained,
    noOpenOrders: snapshot.openOrderIds.length === 0,
    identityMatches: deps.db.identityRegistered(deps.identity),
    capValid: cap.valid,
    gasSufficient: minGasMist <= BigInt(snapshot.botGasSuiMist),
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
  return {
    checks,
    details: {
      capValid: {
        queryErrored: cap.queryErrored,
        failedConjuncts: cap.conjuncts
          ? Object.entries(cap.conjuncts)
              .filter(([, passed]) => !passed)
              .map(([name]) => name)
          : cap.valid
            ? []
            : ["unspecified"],
        conjuncts: cap.conjuncts,
      },
      gasSufficient: {
        actualMist: snapshot.botGasSuiMist,
        actualSui: formatMistAsSui(snapshot.botGasSuiMist),
        thresholdMist: minGasMist.toString(),
        thresholdSui: formatMistAsSui(minGasMist.toString()),
      },
      reconciliation: {
        pages: reconciliation.pages,
        events: reconciliation.events,
      },
    },
    evidence: { reconciliation, balances },
    opened,
  };
}

export function formatMistAsSui(mist: string): string {
  const padded = mist.padStart(PHASE1_DECIMALS.SUI + 1, "0");
  const split = padded.length - PHASE1_DECIMALS.SUI;
  const fraction = padded.slice(split).replace(/0+$/, "");
  return `${padded.slice(0, split)}${fraction ? `.${fraction}` : ""}`;
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
        snapshot: () => reader.snapshot(),
        capValid: () => tradeCapEvidence(config.graphqlUrl, identity),
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
