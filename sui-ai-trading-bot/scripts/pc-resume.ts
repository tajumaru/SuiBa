import { execFile as execFileCallback } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { parse } from "dotenv";
import type { ResetExpectation } from "../apps/worker/src/predecessor-reset.ts";
import { isMainModule } from "./is-main-module.ts";
import type { resumeReal } from "./real-resume.ts";

type ResetScope = ResetExpectation & {
  pending: boolean;
  eligible: boolean;
  reason: string | null;
};
type State = {
  running?: boolean;
  runtime?: { running: boolean };
  safety?: { ordersAllowed: boolean };
  resetScope?: ResetScope;
};
type Control =
  | { command: "start" }
  | {
      command: "reset";
      expectedReset: ResetExpectation;
    };
type Reply = { status: number; body?: unknown };

export type PcResumeDependencies = {
  readToken(): Promise<string | undefined>;
  request(path: string, token: string, control?: Control): Promise<Reply>;
  runRealResume(args: string[]): Promise<{ success: boolean; stdout: string }>;
  wait(ms: number): Promise<unknown>;
  print(message: string): void;
  appendLog?(entry: string): Promise<void>;
};

type ResumeResult = Awaited<ReturnType<typeof resumeReal>>;
const checks = {
  allTransactionsTerminal: true,
  historyComplete: true,
  ledgerIdempotent: true,
  balancesExplained: true,
  noOpenOrders: true,
  identityMatches: true,
  capValid: true,
  gasSufficient: true,
  deepSufficient: true,
  riskAllowed: true,
  profitGuardAllowed: true,
  marketHealthy: true,
} satisfies Record<keyof ResumeResult["checks"], true>;
const engineChecks = ["riskAllowed", "profitGuardAllowed", "marketHealthy"];
const differenceKeys = ["SUI", "DBUSDC", "DEEP"].flatMap((asset) =>
  ["available", "locked", "settled", "owed", "fee", "gas"].map(
    (component) => `${asset}.${component}`,
  ),
);

function parseResult(stdout: string): ResumeResult | undefined {
  try {
    return JSON.parse(stdout.trimEnd().split(/\r?\n/).at(-1) ?? "");
  } catch {
    return undefined;
  }
}

function inspectDryRun(stdout: string) {
  const verdict = stdout
    .split(/\r?\n/)
    .filter(
      (line) => line.startsWith("判定：開けません") || line.startsWith("・"),
    );
  const result = parseResult(stdout);
  const differences = result?.evidence?.balances?.differences;
  const balancesMatch =
    differences &&
    differenceKeys.every((key) => differences[key] === "0") &&
    Object.values(differences).every((value) => value === "0");
  const failed = [
    ...new Set([...Object.keys(checks), ...Object.keys(result?.checks ?? {})]),
  ].filter((key) => result?.checks?.[key as keyof typeof checks] !== true);
  return {
    verdict,
    balanceMismatch: Boolean(differences && !balancesMatch),
    passed: Boolean(balancesMatch && failed.length === 0),
    engineOnly: Boolean(
      balancesMatch &&
      failed.length > 0 &&
      failed.every((key) => engineChecks.includes(key)),
    ),
  };
}

function ok(reply: Reply) {
  return reply.status >= 200 && reply.status < 300;
}

export async function runPcResume(argv: string[], deps: PcResumeDependencies) {
  const args = argv.filter((arg) => arg !== "--");
  const reason =
    args.length === 1 ? /^--reason=(\S+)$/.exec(args[0])?.[1] : undefined;
  if (!reason) {
    deps.print("使い方：pnpm pc:resume -- --reason=<空白を含まない理由>");
    return 1;
  }

  const log = async (entry: string) => {
    try {
      await deps.appendLog?.(entry);
    } catch {
      // 出来事ログは最善努力。書けなくても再開の結果は変えない。
    }
  };
  const token = await deps.readToken().catch(() => undefined);
  if (!token) {
    const message = "再開できませんでした。.env の管理用の鍵を確認してください。";
    deps.print(message);
    await log(
      `${new Date().toISOString()} pc:resume failed reason=${reason} detail=${message}`,
    );
    return 1;
  }
  const fail = async (message: string) => {
    const redacted = message.replaceAll(token, "[伏字]");
    deps.print(redacted);
    await log(
      `${new Date().toISOString()} pc:resume failed reason=${reason} detail=${redacted.split(/\r?\n/)[0]}`,
    );
    return 1;
  };
  const request = (path: string, control?: Control) =>
    deps.request(path, token, control).catch(() => undefined);
  const initial = await request("/api/state");
  if (!initial) return await fail("Botが応答しません");
  const state = initial.body as State | undefined;
  const running = state?.running ?? state?.runtime?.running;
  if (!ok(initial) || !state || typeof running !== "boolean")
    return await fail("再開できませんでした。Botの状態を確認できません。");

  let scope = state.resetScope;
  if (scope === undefined) {
    const deployment = await request("/api/deployment");
    if (!deployment || !ok(deployment))
      return await fail(
        "再開できませんでした。停止エラーを解除できるか確認できません。",
      );
    scope = (deployment.body as { resetScope?: ResetScope } | undefined)
      ?.resetScope;
  }
  if (typeof scope?.pending !== "boolean")
    return await fail(
      "再開できませんでした。停止エラーを解除できるか確認できません。",
    );

  const control = async (command: Control, failure: string) => {
    const reply = await request("/api/control", command);
    if (reply && ok(reply)) return true;
    const error = (reply?.body as { error?: unknown } | undefined)?.error;
    await fail(typeof error === "string" ? `${failure}\n${error}` : failure);
    return false;
  };
  if (scope.pending) {
    if (scope.eligible !== true)
      return await fail(
        `再開できませんでした。停止エラーを解除できません。\n${scope.reason ?? "解除できない理由は不明です。"}`,
      );
    const { version, bootId, pair, generation, expectedError } = scope;
    if (
      !(await control(
        {
          command: "reset",
          expectedReset: { version, bootId, pair, generation, expectedError },
        },
        "再開できませんでした。停止エラーの解除に失敗しました。",
      ))
    )
      return 1;
  }

  const starting = !running;
  if (
    starting &&
    !(await control(
      { command: "start" },
      "再開できませんでした。Botを起動できません。",
    ))
  )
    return 1;

  for (let retries = 0; ; retries++) {
    const dryRun = await deps.runRealResume([]).catch(() => undefined);
    const result = inspectDryRun(dryRun?.stdout ?? "");
    if (dryRun?.success && result.passed) break;
    if (dryRun?.success && starting && result.engineOnly && retries < 3) {
      await deps.wait(30_000);
      continue;
    }
    return await fail(
      [
        "再開できませんでした。再開前の確認を通過できません。",
        ...result.verdict,
        ...(result.balanceMismatch ? ["残高の差を確認してください。"] : []),
      ].join("\n"),
    );
  }

  const approval = await deps
    .runRealResume(["--", "--approve", `--reason=${reason}`])
    .catch(() => undefined);
  if (!approval?.success || parseResult(approval.stdout)?.opened !== true)
    return await fail("再開できませんでした。注文の許可を出す処理に失敗しました。");

  const final = await request("/api/state");
  const finalState = final?.body as State | undefined;
  if (
    !final ||
    !ok(final) ||
    (finalState?.running ?? finalState?.runtime?.running) !== true ||
    finalState?.safety?.ordersAllowed !== true
  )
    return await fail(
      "再開を確認できませんでした。Botの稼働と注文の許可を両方確認できません。",
    );

  await log(
    `${new Date().toISOString()} pc:resume success reason=${reason}`,
  );
  deps.print("再開しました");
  return 0;
}

const execFile = promisify(execFileCallback);

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = await runPcResume(process.argv.slice(2), {
    readToken: async () => parse(await readFile(".env")).ADMIN_TOKEN,
    async request(path, token, control) {
      const response = await fetch(`http://localhost:3100${path}`, {
        method: control ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(control ? { "Content-Type": "application/json" } : {}),
        },
        body: control && JSON.stringify(control),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => undefined),
      };
    },
    async runRealResume(args) {
      // Use pnpm's JS entry point so Windows needs no shell or .cmd quoting.
      const pnpmEntry = process.env.npm_execpath;
      const command = pnpmEntry ? process.execPath : "pnpm";
      const commandArgs = [
        ...(pnpmEntry ? [pnpmEntry] : []),
        "real:resume",
        ...args,
      ];
      try {
        const { stdout } = await execFile(command, commandArgs);
        return { success: true, stdout };
      } catch (error) {
        const { stdout } = error as { stdout?: string };
        return { success: false, stdout: stdout ?? "" };
      }
    },
    wait,
    print: console.log,
    appendLog: async (entry) => {
      await appendFile("data/pc-ops.log", `${entry}\n`);
    },
  });
}
