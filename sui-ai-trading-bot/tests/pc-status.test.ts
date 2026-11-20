import { describe, expect, it, vi } from "vitest";
import { runPcStatus } from "../scripts/pc-status.ts";

const token = "test-admin-token";
const settings = {
  oversold: 45,
  maxOrder: 1,
  minNetProfitUsdc: 0.001,
  emaGapShrinkEnabled: true,
  emaGapShrinkCandles: 3,
};
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
};
const differences = Object.fromEntries(
  ["SUI", "DBUSDC", "DEEP"].flatMap((asset) =>
    ["available", "locked", "settled", "owed", "fee", "gas"].map(
      (component) => [`${asset}.${component}`, "0"],
    ),
  ),
);
const runningState = {
  runtime: { running: true, emergency: false, error: null },
  safety: { ordersAllowed: true },
  settings,
  resetScope: { pending: false },
  portfolio: { sui: 999999 },
};

function setup() {
  return {
    readToken: vi.fn(async () => token),
    get: vi.fn(
      async (
        _path: string,
        _key: string,
      ): Promise<{ status: number; body: unknown }> => ({
        status: 200,
        body: runningState,
      }),
    ),
    runRealResume: vi.fn(async () => resumeOutput()),
    print: vi.fn<(message: string) => void>(),
  };
}

function resumeOutput(balanceDiff = differences, results = checks) {
  return `残高の確認中\r\n${JSON.stringify({
    checks: results,
    evidence: { balances: { differences: balanceDiff } },
  })}\r\n`;
}

describe("pc:status", () => {
  it("稼働中で残高の差分がすべて0なら一致と表示する", async () => {
    const deps = setup();
    expect(await runPcStatus(deps)).toBe(0);
    expect(deps.get).toHaveBeenCalledExactlyOnceWith("/api/state", token);
    expect(deps.runRealResume).toHaveBeenCalledExactlyOnceWith();
    expect(deps.print.mock.calls[0][0]).toBe(
      [
        "正常に稼働中です",
        "稼働：稼働中",
        "注文許可：あり",
        "緊急停止：なし",
        "エラー：なし",
        "残高：開始時と一致（差分オール0）",
        "判定：全チェックOK",
        "設定：売られすぎライン 45、注文上限 1 USDC、最低純利益 0.001 USDC、EMA縮小条件 オン（3本）",
      ].join("\n"),
    );
  });

  it("停止中のエラーと別の読み取り先にある解除待ちを表示する", async () => {
    const deps = setup();
    const stopped = {
      runtime: { running: false, emergency: true, error: `停止理由 ${token}` },
      safety: { ordersAllowed: false },
      settings: { ...settings, emaGapShrinkEnabled: false },
    };
    deps.get
      .mockResolvedValueOnce({ status: 200, body: stopped })
      .mockResolvedValueOnce({
        status: 200,
        body: { resetScope: { pending: true, expectedError: "停止理由" } },
      });
    expect(await runPcStatus(deps)).toBe(0);
    expect(deps.get.mock.calls).toEqual([
      ["/api/state", token],
      ["/api/deployment", token],
    ]);
    const output = deps.print.mock.calls[0][0];
    expect(output.split("\n")[0]).toBe("止まっています");
    expect(output).toContain(
      "注文許可：なし\n緊急停止：あり\nエラー：あり（停止理由 [伏字]）",
    );
    expect(output).toContain("EMA縮小条件 オフ（3本）");
    expect(output).toContain("エラーの解除待ち：停止理由");
  });

  it("0でない残高差分と通らなかった確認項目を表示する", async () => {
    const deps = setup();
    deps.runRealResume.mockResolvedValue(
      resumeOutput(
        {
          ...differences,
          "SUI.gas": "-123",
          "DEEP.available": "9007199254740993",
        },
        { ...checks, balancesExplained: false },
      ),
    );
    expect(await runPcStatus(deps)).toBe(0);
    const output = deps.print.mock.calls[0][0];
    expect(output).toContain(
      "残高：差分あり\n・SUI.gas：-123\n・DEEP.available：9007199254740993\n判定：問題あり（残高の説明）",
    );
  });

  it("Botに接続できない場合は残高確認をせず終了コード1を返す", async () => {
    const deps = setup();
    deps.get.mockRejectedValue(new Error(token));
    expect(await runPcStatus(deps)).toBe(1);
    expect(deps.print).toHaveBeenCalledExactlyOnceWith(
      "Botが応答しません\nBotに接続できませんでした。",
    );
    expect(deps.runRealResume).not.toHaveBeenCalled();
  });

  it("管理用の鍵が拒否された場合も終了コード0を返す", async () => {
    const deps = setup();
    deps.get.mockResolvedValue({ status: 401, body: { error: token } });
    expect(await runPcStatus(deps)).toBe(0);
    expect(deps.print).toHaveBeenCalledExactlyOnceWith(
      "Botが応答しません\nBotが管理用の鍵を受け付けませんでした。",
    );
    expect(deps.runRealResume).not.toHaveBeenCalled();
  });

  it("残高確認に失敗した場合もBotの状態を表示する", async () => {
    const deps = setup();
    deps.runRealResume.mockRejectedValue(new Error(token));
    expect(await runPcStatus(deps)).toBe(0);
    expect(deps.print.mock.calls[0][0]).toContain(
      "残高：確認できません\n判定：確認できません",
    );
  });

  it("確認結果が一部だけなら一致や全チェックOKと表示しない", async () => {
    const deps = setup();
    deps.runRealResume.mockResolvedValue(
      JSON.stringify({
        checks: { noOpenOrders: true },
        evidence: { balances: { differences: { "SUI.gas": "0" } } },
      }),
    );
    expect(await runPcStatus(deps)).toBe(0);
    expect(deps.print.mock.calls[0][0]).toContain(
      "残高：確認できません\n判定：確認できません",
    );
  });
});
