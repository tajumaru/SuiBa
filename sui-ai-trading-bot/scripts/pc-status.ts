import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parse } from "dotenv";
import { z } from "zod";
import { isMainModule } from "./is-main-module.ts";
import type { resumeReal } from "./real-resume.ts";

const resetScopeSchema = z.object({
  pending: z.boolean(),
  expectedError: z.string().nullish(),
});
const stateSchema = z.object({
  running: z.boolean().optional(),
  runtime: z
    .object({
      running: z.boolean(),
      emergency: z.boolean(),
      error: z.string().nullish(),
    })
    .optional(),
  safety: z.object({ ordersAllowed: z.boolean() }).optional(),
  settings: z
    .object({
      oversold: z.number(),
      maxOrder: z.number(),
      minNetProfitUsdc: z.number(),
      emaGapShrinkEnabled: z.boolean(),
      emaGapShrinkCandles: z.number(),
    })
    .partial()
    .optional(),
  realReconciliation: z
    .object({ nonTerminalSubmissions: z.number().int().nonnegative() })
    .optional(),
  realExecution: z
    .object({
      orderType: z.enum(["MARKET", "IOC_LIMIT"]),
      maxOrderDbusdc: z.number().optional(),
    })
    .optional(),
  resetScope: resetScopeSchema.optional(),
  currentResetScope: resetScopeSchema.optional(),
});
const resumeSchema = z.object({
  checks: z.record(z.string(), z.boolean()).optional(),
  evidence: z
    .object({
      balances: z.object({
        differences: z.record(z.string(), z.string().regex(/^-?\d+$/)),
      }),
    })
    .optional(),
});

type State = z.infer<typeof stateSchema>;
type Resume = z.infer<typeof resumeSchema>;
type Check = keyof Awaited<ReturnType<typeof resumeReal>>["checks"];
const checkLabels = {
  allTransactionsTerminal: "取引の後片付け",
  historyComplete: "履歴の取得",
  ledgerIdempotent: "取引記録の照合",
  balancesExplained: "残高の説明",
  noOpenOrders: "未約定の注文",
  identityMatches: "本人確認",
  capValid: "取引許可証",
  gasSufficient: "取引に必要な費用",
  deepSufficient: "手数料用の DEEP",
  riskAllowed: "取引の安全確認",
  profitGuardAllowed: "利益の確認",
  marketHealthy: "相場の確認",
} satisfies Record<Check, string>;
const differenceKeys = ["SUI", "DBUSDC", "DEEP"].flatMap((asset) =>
  ["available", "locked", "settled", "owed", "fee", "gas"].map(
    (component) => `${asset}.${component}`,
  ),
);

export type PcStatusDependencies = {
  readToken(): Promise<string | undefined>;
  get(
    path: "/api/state" | "/api/deployment",
    token: string,
  ): Promise<{
    status: number;
    body?: unknown;
  }>;
  runRealResume(): Promise<string>;
  print(message: string): void;
};

function parseResume(stdout: string): Resume | undefined {
  try {
    return resumeSchema.safeParse(
      JSON.parse(stdout.trimEnd().split(/\r?\n/).at(-1) ?? ""),
    ).data;
  } catch {
    return undefined;
  }
}

const unknown = "確認できません";
const onOff = (value: boolean | undefined, on: string, off: string) =>
  value === undefined ? unknown : value ? on : off;
const setting = (value: number | undefined, unit = "") =>
  value === undefined ? unknown : `${value}${unit}`;

function formatBalance(differences: Record<string, string> | undefined) {
  if (!differences) return unknown;
  const nonzero = Object.entries(differences).filter(
    ([, value]) => BigInt(value) !== 0n,
  );
  const complete = differenceKeys.every((key) =>
    Object.hasOwn(differences, key),
  );
  if (!nonzero.length)
    return complete ? "開始時と一致（差分オール0）" : unknown;
  return [
    "差分あり",
    ...nonzero.map(([key, value]) => `・${key}：${value}`),
    ...(!complete ? ["・一部の項目を確認できません"] : []),
  ].join("\n");
}

function formatChecks(checks: Resume["checks"], reconciliationPending: boolean) {
  const failed = Object.entries(checks ?? {})
    .filter(([, passed]) => !passed)
    .map(([key]) =>
      Object.hasOwn(checkLabels, key) ? checkLabels[key as Check] : key,
    );
  if (reconciliationPending) failed.push("未確定の送信");
  const complete =
    checks && Object.keys(checkLabels).every((key) => Object.hasOwn(checks, key));
  if (!failed.length) return complete ? "全チェックOK" : unknown;
  return `問題あり（${failed.join("、")}）${complete ? "" : "。一部は確認できません"}`;
}

export function formatPcStatus(
  state: State,
  running: boolean,
  resume?: Resume,
) {
  const { runtime, safety, settings, currentResetScope } = state;
  const nonTerminalSubmissions = state.realReconciliation?.nonTerminalSubmissions ?? 0;
  const reconciliationPending = nonTerminalSubmissions > 0;
  const resetScope = state.resetScope?.pending
    ? state.resetScope
    : currentResetScope?.pending
      ? currentResetScope
      : state.resetScope;
  return [
    running ? "正常に稼働中です" : "止まっています",
    `稼働：${onOff(running, "稼働中", "停止中")}`,
    `注文許可：${onOff(safety?.ordersAllowed, "あり", "なし")}`,
    `緊急停止：${onOff(runtime?.emergency, "あり", "なし")}`,
    `エラー：${runtime ? (runtime.error ? `あり（${runtime.error}）` : "なし") : unknown}`,
    `残高：${formatBalance(resume?.evidence?.balances.differences)}`,
    ...(reconciliationPending
      ? [`未確定の送信：${nonTerminalSubmissions}件（照合待ちで注文が止まっています）`]
      : []),
    `判定：${formatChecks(resume?.checks, reconciliationPending)}`,
    `設定：売られすぎライン ${setting(settings?.oversold)}、注文上限 ${setting(settings?.maxOrder, " USDC")}、最低純利益 ${setting(settings?.minNetProfitUsdc, " USDC")}、EMA縮小条件 ${onOff(settings?.emaGapShrinkEnabled, "オン", "オフ")}（${setting(settings?.emaGapShrinkCandles, "本")}）${state.realExecution ? `、注文種別 ${state.realExecution.orderType === "MARKET" ? "成行" : "指値（IOC）"}${state.realExecution.maxOrderDbusdc != null ? `、安全上限 ${state.realExecution.maxOrderDbusdc} USDC` : ""}` : ""}`,
    ...(resetScope?.pending
      ? [`エラーの解除待ち：${resetScope.expectedError ?? "エラーの記録なし"}`]
      : resetScope
        ? []
        : [`エラーの解除待ち：${unknown}`]),
  ].join("\n");
}

type PcStatusFailureKind = "refused" | "unresponsive" | "unreachable";

export function pcStatusFailureKind(error: unknown): PcStatusFailureKind {
  if (typeof error !== "object" || error === null) return "unreachable";
  const cause = "cause" in error ? error.cause : undefined;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "ECONNREFUSED"
  )
    return "refused";
  if (
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return "unresponsive";
  return "unreachable";
}

const failureDetails: Record<PcStatusFailureKind, string> = {
  refused: "Botのプロセスが動いていません（3100番に接続できませんでした）。",
  unresponsive: "Botのプロセスは応答していません（時間内に返事がありませんでした）。",
  unreachable: "Botに接続できませんでした。",
};

export async function runPcStatus(deps: PcStatusDependencies) {
  const unavailable = (detail: string, exitCode: number) => {
    deps.print(`Botが応答しません\n${detail}`);
    return exitCode;
  };
  const token = await deps.readToken().catch(() => undefined);
  if (!token) return unavailable(".env の管理用の鍵を確認してください。", 0);

  let reply: Awaited<ReturnType<PcStatusDependencies["get"]>>;
  try {
    reply = await deps.get("/api/state", token);
  } catch (error) {
    return unavailable(failureDetails[pcStatusFailureKind(error)], 1);
  }
  if (reply.status === 401 || reply.status === 403)
    return unavailable("Botが管理用の鍵を受け付けませんでした。", 0);
  const state = stateSchema.safeParse(reply.body).data;
  const running = state?.running ?? state?.runtime?.running;
  if (reply.status !== 200 || !state || running === undefined)
    return unavailable("Botの状態を読み取れませんでした。", 0);

  if (!state.resetScope) {
    const deployment = await deps
      .get("/api/deployment", token)
      .catch(() => undefined);
    if (deployment?.status === 200)
      state.resetScope = z
        .object({ resetScope: resetScopeSchema })
        .safeParse(deployment.body).data?.resetScope;
  }
  const stdout = await deps.runRealResume().catch(() => "");
  deps.print(
    formatPcStatus(state, running, parseResume(stdout)).replaceAll(
      token,
      "[伏字]",
    ),
  );
  return 0;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await runPcStatus({
    readToken: async () => parse(await readFile(".env")).ADMIN_TOKEN,
    async get(path, token) {
      const response = await fetch(`http://localhost:3100${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => undefined),
      };
    },
    async runRealResume() {
      // pnpm の JavaScript 入口を使い、Windows でもシェルを介さず実行する。
      const pnpmEntry = process.env.npm_execpath;
      const command = pnpmEntry ? process.execPath : "pnpm";
      const args = pnpmEntry ? [pnpmEntry, "real:resume"] : ["real:resume"];
      const { stdout } = await promisify(execFile)(command, args);
      return stdout;
    },
    print: console.log,
  });
}
