import "dotenv/config";

import { realConfigFromEnv } from "../apps/worker/src/real/config.ts";
import {
  RealTradeCapDatabase,
  type RealBalanceBaseline,
} from "../apps/worker/src/real/database.ts";
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

import {
  atomic,
  balanceEvidence,
  PHASE1_DECIMALS,
  type Asset,
} from "../apps/worker/src/real/balance-evidence.ts";

export { atomic, balanceEvidence, PHASE1_DECIMALS };
export const ENGINE_CHECKS_MAX_AGE_MS = 2 * 60 * 1000;

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
    record?: { risk: string; profitGuard: string; market: string };
    ageMs?: number;
  }>;
  reportBeforeBaseline?(report: unknown): void;
}

type ResumeChecks = Record<
  | "allTransactionsTerminal"
  | "historyComplete"
  | "ledgerIdempotent"
  | "balancesExplained"
  | "noOpenOrders"
  | "identityMatches"
  | "capValid"
  | "gasSufficient"
  | "deepSufficient"
  | "riskAllowed"
  | "profitGuardAllowed"
  | "marketHealthy",
  boolean
>;

class OwnerApprovalRequiredError extends Error {
  constructor(
    readonly checks: ResumeChecks,
    readonly capDetails: { queryErrored: boolean; failedConjuncts: string[] },
    readonly gasDetails: {
      actualSui: string;
      thresholdSui: string;
    },
  ) {
    super("REAL_OWNER_APPROVAL_REQUIRED");
  }
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
    record: undefined,
    ageMs: undefined,
  };
  const record = db.latestEngineChecks(identity);
  if (!record) return denied;
  const details = {
    record: {
      risk: record.risk,
      profitGuard: record.profitGuard,
      market: record.market,
    },
    ageMs: now - record.recordedAt,
  };
  if (
    JSON.stringify(record.identity) !== JSON.stringify(identity) ||
    !Number.isFinite(record.recordedAt) ||
    record.recordedAt > now ||
    now - record.recordedAt > ENGINE_CHECKS_MAX_AGE_MS
  )
    return { ...denied, ...details };
  return {
    riskAllowed: record.risk === "ALLOWED" || record.risk === "NOT_EVALUATED",
    profitGuardAllowed:
      record.profitGuard === "ALLOWED" ||
      record.profitGuard === "NOT_EVALUATED",
    marketHealthy: record.market === "HEALTHY",
    ...details,
  };
}

function baselineFromSnapshot(
  snapshot: Awaited<ReturnType<ResumeDependencies["snapshot"]>>,
  rows: Array<Record<string, string>>,
): Omit<RealBalanceBaseline, "recordedAt"> {
  return {
    assets: Object.fromEntries(
      (Object.keys(PHASE1_DECIMALS) as Asset[]).map((asset) => [
        asset,
        {
          availableAtomic: atomic(
            snapshot.balances[asset] as number | string,
            PHASE1_DECIMALS[asset],
          ).toString(),
          lockedAtomic: atomic(
            (snapshot.locked[asset] ?? 0) as number | string,
            PHASE1_DECIMALS[asset],
          ).toString(),
          settledUnclaimedAtomic: atomic(
            (snapshot.settledUnclaimed[asset] ?? 0) as number | string,
            PHASE1_DECIMALS[asset],
          ).toString(),
          owedAtomic: atomic(
            (snapshot.owedBalances?.[asset] ?? 0) as number | string,
            PHASE1_DECIMALS[asset],
          ).toString(),
        },
      ]),
    ) as RealBalanceBaseline["assets"],
    botGasSuiMist: snapshot.botGasSuiMist,
    ledgerOffsets: Object.fromEntries(
      (Object.keys(PHASE1_DECIMALS) as Asset[]).map((asset) => {
        const row = rows.find((candidate) => candidate.asset === asset) ?? {};
        return [
          asset,
          {
            availableAtomic: row.availableAtomic ?? "0",
            lockedAtomic: row.orderLockedAtomic ?? "0",
            settledUnclaimedAtomic: row.settledUnclaimedAtomic ?? "0",
            feeAtomic: row.feeAtomic ?? "0",
            gasMist: row.gasMist ?? "0",
          },
        ];
      }),
    ) as NonNullable<RealBalanceBaseline["ledgerOffsets"]>,
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
  const previousBaseline = deps.db.balanceBaseline(deps.identity);
  let balances = balanceEvidence(
    deps.db.balanceLedger(deps.identity),
    snapshot,
    previousBaseline,
    deps.db.appliedTradeFeeCount(deps.identity),
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
    riskAllowed: engine.riskAllowed,
    profitGuardAllowed: engine.profitGuardAllowed,
    marketHealthy: engine.marketHealthy,
  };
  let opened = false;
  let baselineAction: "recorded" | "re-recorded" | undefined;
  let attestedDifferences: Record<string, string> | undefined;
  if (options.approve) {
    if (!options.ownerApproval)
      throw new OwnerApprovalRequiredError(
        checks,
        {
          queryErrored: cap.queryErrored,
          failedConjuncts: cap.conjuncts
            ? Object.entries(cap.conjuncts)
                .filter(([, passed]) => !passed)
                .map(([name]) => name)
            : cap.valid
              ? []
              : ["unspecified"],
        },
        {
          actualSui: formatMistAsSui(snapshot.botGasSuiMist),
          thresholdSui: formatMistAsSui(minGasMist.toString()),
        },
      );
    const otherChecksPass = Object.entries(checks).every(
      ([name, passed]) => name === "balancesExplained" || passed,
    );
    if (otherChecksPass && checkpoint) {
      if (!previousBaseline || !balances.explained) {
        deps.reportBeforeBaseline?.({
          checks,
          evidence: { balances },
          baseline: {
            action: previousBaseline ? "re-recorded" : "recorded",
            previousDifferences: balances.differences,
          },
        });
        attestedDifferences = { ...balances.differences };
        deps.db.recordBalanceBaseline(
          deps.identity,
          baselineFromSnapshot(snapshot, deps.db.balanceLedger(deps.identity)),
        );
        baselineAction = previousBaseline ? "re-recorded" : "recorded";
        balances = balanceEvidence(
          deps.db.balanceLedger(deps.identity),
          snapshot,
          deps.db.balanceBaseline(deps.identity),
          deps.db.appliedTradeFeeCount(deps.identity),
        );
        checks.balancesExplained = balances.explained;
      }
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
      engineChecks: { record: engine.record, ageMs: engine.ageMs },
      baseline: {
        action: baselineAction,
        previousDifferences: attestedDifferences,
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

type ResumeResult = Awaited<ReturnType<typeof resumeReal>>;
type ResumeSnapshot = Awaited<ReturnType<ResumeDependencies["snapshot"]>>;

const CHECK_LABELS: Record<keyof ResumeResult["checks"], string> = {
  allTransactionsTerminal: "取引の後片付け",
  historyComplete: "履歴の取得",
  ledgerIdempotent: "台帳の照合",
  balancesExplained: "残高の説明",
  noOpenOrders: "未約定の注文",
  identityMatches: "本人確認",
  capValid: "取引許可証（TradeCap）",
  gasSufficient: "ガス代の残高",
  deepSufficient: "手数料用の DEEP",
  riskAllowed: "リスク判定",
  profitGuardAllowed: "ProfitGuard",
  marketHealthy: "相場の健全性",
};

function failedCheckReason(
  name: keyof ResumeResult["checks"],
  details: {
    capValid: { queryErrored: boolean; failedConjuncts: string[] };
    gasSufficient: { actualSui: string; thresholdSui: string };
  },
): string {
  const reasons: Record<keyof ResumeResult["checks"], string> = {
    allTransactionsTerminal: "送信済みの取引に未確定のものがあります",
    historyComplete: "チェーンの履歴を最後まで読めていません",
    ledgerIdempotent: "台帳の再計算で件数が変わりました",
    balancesExplained:
      "残高と台帳が合いません（開始残高の記録か、差分の確認が必要です）",
    noOpenOrders: "まだ約定していない注文が残っています",
    identityMatches: "この台帳は別の Bot／口座のものです",
    capValid: `許可証が見つからないか、Bot のものではありません（${
      details.capValid.queryErrored
        ? "照会エラー"
        : `不一致：${details.capValid.failedConjuncts.join("、")}`
    }）`,
    gasSufficient: `Bot の SUI 残高が不足しています（実績 ${details.gasSufficient.actualSui} SUI／必要 ${details.gasSufficient.thresholdSui} SUI）`,
    deepSufficient: "DEEP の残高が不足しています",
    riskAllowed: "リスク判定が取引を止めています",
    profitGuardAllowed: "ProfitGuardが取引を止めています",
    marketHealthy: "相場データが古いか取得できていません",
  };
  return reasons[name];
}

export function plainResumeLines(
  result: ResumeResult,
  options: { approve: boolean; snapshot?: ResumeSnapshot },
): string[] {
  const failed = (
    Object.keys(result.checks) as Array<keyof typeof result.checks>
  ).filter((name) => !result.checks[name]);
  const lines = [
    result.opened
      ? "判定：開きました"
      : failed.length === 0 && !options.approve
        ? "判定：開けます（全チェックOK）"
        : "判定：開けません",
    ...failed.map(
      (name) =>
        `・${CHECK_LABELS[name]}：${failedCheckReason(name, result.details)}`,
    ),
  ];
  if (result.details.baseline.action && options.snapshot) {
    const action =
      result.details.baseline.action === "recorded" ? "記録" : "再記録";
    lines.push(
      `開始残高を${action}しました（SUI ${String(options.snapshot.balances.SUI)}、DBUSDC ${String(options.snapshot.balances.DBUSDC)}、DEEP ${String(options.snapshot.balances.DEEP)}、Bot ガス ${formatMistAsSui(options.snapshot.botGasSuiMist)} SUI）`,
    );
  }
  return lines;
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
  const approve = argv.includes("--approve");
  const bufferedJson: string[] = [];
  let snapshot: ResumeSnapshot | undefined;
  try {
    const result = await resumeReal(
      {
        db,
        identity,
        reconcile: () => reconciler.reconcileAllPages(),
        snapshot: async () => (snapshot = await reader.snapshot()),
        capValid: () => tradeCapEvidence(config.graphqlUrl, identity),
        engineChecks: async () => readEngineChecks(db, identity),
        reportBeforeBaseline: (report) =>
          bufferedJson.push(JSON.stringify(report)),
      },
      {
        approve,
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
    for (const line of plainResumeLines(result, { approve, snapshot }))
      console.info(line);
    for (const json of bufferedJson) console.info(json);
    console.info(JSON.stringify(result));
    return result;
  } catch (error) {
    if (error instanceof OwnerApprovalRequiredError) {
      const failed = (
        Object.keys(error.checks) as Array<keyof ResumeChecks>
      ).filter((name) => !error.checks[name]);
      console.info("判定：開けません");
      for (const name of failed)
        console.info(
          `・${CHECK_LABELS[name]}：${failedCheckReason(name, {
            capValid: error.capDetails,
            gasSufficient: error.gasDetails,
          })}`,
        );
    }
    if (
      error instanceof Error &&
      error.message === "REAL_UNIDENTIFIABLE_PREDECESSOR"
    )
      console.info(
        "判定：開けません・前任の Bot を特定できないため、恒久的に再開できません",
      );
    throw error;
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url, process.argv[1]))
  await runResume(process.env, process.argv.slice(2));
