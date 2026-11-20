import { describe, expect, it, vi } from "vitest";
import { runPcResume } from "../scripts/pc-resume.ts";

const expectedReset = {
  version: 1,
  bootId: "boot",
  pair: "SUI_USDC",
  generation: "generation",
  expectedError: "SAFE_STOP",
} as const;
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
function dryRun(changes: Partial<typeof checks> = {}, deltas = differences) {
  const verdict = Object.values(changes).includes(false)
    ? "判定：開けません"
    : "判定：開けます（全チェックOK）";
  return {
    success: true,
    stdout: `${verdict}\n${JSON.stringify({
      checks: { ...checks, ...changes },
      evidence: { balances: { differences: deltas } },
      opened: false,
    })}\n`,
  };
}

function fixture(
  scope = { pending: false, eligible: false, reason: null as string | null },
) {
  const deps = {
    readToken: vi.fn(async () => "fixture-auth"),
    request: vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        body: { running: false, resetScope: { ...expectedReset, ...scope } },
      })
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({
        status: 200,
        body: { running: true, safety: { ordersAllowed: true } },
      }),
    runRealResume: vi
      .fn()
      .mockResolvedValueOnce(dryRun())
      .mockResolvedValueOnce({ success: true, stdout: '{"opened":true}\n' }),
    wait: vi.fn(async (_ms: number) => {}),
    print: vi.fn(),
  };
  return {
    deps,
    run: (args = ["--", "--reason=PC再開"]) => runPcResume(args, deps),
  };
}

describe("pc:resume", () => {
  it("starts without resetting when there is no pending reset", async () => {
    const { deps, run } = fixture();
    expect(await run()).toBe(0);
    expect(
      deps.request.mock.calls.map(([path, , control]) => [path, control]),
    ).toEqual([
      ["/api/state", undefined],
      ["/api/control", { command: "start" }],
      ["/api/state", undefined],
    ]);
  });

  it("sends exactly the five expected reset fields before starting", async () => {
    const { deps, run } = fixture({
      pending: true,
      eligible: true,
      reason: null,
    });
    deps.request.mockResolvedValueOnce({
      status: 200,
      body: { running: true, safety: { ordersAllowed: true } },
    });
    expect(await run()).toBe(0);
    expect(deps.request.mock.calls[1][2]).toEqual({
      command: "reset",
      expectedReset,
    });
    expect(deps.request.mock.calls[2][2]).toEqual({ command: "start" });
  });

  it("stops without starting or approving if reset is refused", async () => {
    const { deps, run } = fixture({
      pending: true,
      eligible: false,
      reason: "RESET_EMERGENCY_ACTIVE",
    });
    expect(await run()).toBe(1);
    expect(deps.request).toHaveBeenCalledTimes(1);
    expect(deps.runRealResume).not.toHaveBeenCalled();
    expect(deps.print).toHaveBeenCalledWith(
      expect.stringContaining("RESET_EMERGENCY_ACTIVE"),
    );
  });

  it("shows the verdict and stops when a check fails", async () => {
    const { deps, run } = fixture();
    deps.runRealResume
      .mockReset()
      .mockResolvedValue(dryRun({ noOpenOrders: false }));
    expect(await run()).toBe(1);
    expect(deps.runRealResume.mock.calls).toEqual([[[]]]);
    expect(deps.print).toHaveBeenCalledWith(
      expect.stringContaining("判定：開けません"),
    );
  });

  it("stops when a balance differs even with all checks passing", async () => {
    const { deps, run } = fixture();
    deps.runRealResume
      .mockReset()
      .mockResolvedValue(dryRun({}, { ...differences, "SUI.gas": "1" }));
    expect(await run()).toBe(1);
    expect(deps.runRealResume.mock.calls).toEqual([[[]]]);
  });

  it("approves with the supplied reason and reports success", async () => {
    const { deps, run } = fixture();
    expect(await run()).toBe(0);
    expect(deps.runRealResume.mock.calls).toEqual([
      [[]],
      [["--", "--approve", "--reason=PC再開"]],
    ]);
    expect(deps.print.mock.calls).toEqual([["再開しました"]]);
  });

  it.each([
    { args: [] },
    { args: ["--reason="] },
    { args: ["--reason=二 語"] },
  ])("requires a single-word reason ($args)", async ({ args }) => {
    const { deps, run } = fixture();
    expect(await run(args)).toBe(1);
    expect(deps.readToken).not.toHaveBeenCalled();
    expect(deps.request).not.toHaveBeenCalled();
    expect(deps.runRealResume).not.toHaveBeenCalled();
    expect(deps.print).toHaveBeenCalledWith(expect.stringContaining("使い方"));
  });

  it("waits at most three times after starting if only engine checks fail", async () => {
    const { deps, run } = fixture();
    deps.runRealResume
      .mockReset()
      .mockResolvedValue(dryRun({ marketHealthy: false }));
    expect(await run()).toBe(1);
    expect(deps.wait.mock.calls).toEqual([[30_000], [30_000], [30_000]]);
    expect(deps.runRealResume.mock.calls).toEqual([[[]], [[]], [[]], [[]]]);
  });

  it("uses the current state and deployment response shapes", async () => {
    const { deps, run } = fixture();
    deps.request
      .mockReset()
      .mockResolvedValueOnce({
        status: 200,
        body: { runtime: { running: false } },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { resetScope: { ...expectedReset, pending: false } },
      })
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({
        status: 200,
        body: { runtime: { running: true }, safety: { ordersAllowed: true } },
      });
    expect(await run()).toBe(0);
    expect(deps.request.mock.calls.map(([path]) => path)).toEqual([
      "/api/state",
      "/api/deployment",
      "/api/control",
      "/api/state",
    ]);
  });

  it("stops before checking approval when start returns 409", async () => {
    const { deps, run } = fixture();
    deps.request
      .mockReset()
      .mockResolvedValueOnce({
        status: 200,
        body: { running: false, resetScope: { pending: false } },
      })
      .mockResolvedValueOnce({
        status: 409,
        body: { error: "RESET_REQUIRED" },
      });
    expect(await run()).toBe(1);
    expect(deps.runRealResume).not.toHaveBeenCalled();
    expect(deps.print).toHaveBeenCalledWith(
      expect.stringContaining("RESET_REQUIRED"),
    );
  });

  it("requires orders to be allowed in the final state", async () => {
    const { deps, run } = fixture();
    deps.request
      .mockReset()
      .mockResolvedValueOnce({
        status: 200,
        body: { running: true, resetScope: { pending: false } },
      })
      .mockResolvedValueOnce({
        status: 200,
        body: { running: true, safety: { ordersAllowed: false } },
      });
    expect(await run()).toBe(1);
    expect(deps.print).toHaveBeenCalledWith(
      expect.stringContaining("再開を確認できませんでした"),
    );
  });
});
