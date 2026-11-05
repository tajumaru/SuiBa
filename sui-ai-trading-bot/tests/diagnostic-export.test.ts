import { expect, it } from "vitest";
import {
  buildDiagnosticReport,
  episodeSummaryText,
} from "../apps/dashboard/src/diagnosticExport.ts";
import type { OperationsSnapshot } from "../apps/dashboard/src/operationsTypes.ts";

const snapshot = (patch: Record<string, unknown> = {}) =>
  ({
    status: "ABNORMAL_STOP",
    workerBuild: "abc1234",
    stopReason: "PAPER_RECOVERY_EXHAUSTED",
    processStartedAt: 1000,
    runningMs: 60000,
    lastMarketAt: 2000,
    lastQuoteAt: 2000,
    lastTradeAt: null,
    safety: {
      botState: "ABNORMAL_STOP",
      connectivity: "DEGRADED",
      resumePending: false,
      episodeAt: null,
      failures: 0,
      episodeTally: {},
      latestApiError: null,
    },
    apis: [
      {
        api: "GeckoTerminal",
        circuit: "CLOSED",
        backoff: false,
        delayed: true,
        requestsPerMinute: 3,
        lastSuccessAt: 1500,
        lastFailure: {
          code: "UPSTREAM_HTTP_429",
          occurredAt: 1900,
        },
      },
    ],
    reports: [
      {
        hours: 24,
        from: 0,
        until: 86400000,
        stopReasons: [{ timestamp: 5000, reason: "PAPER_RECOVERY_EXHAUSTED" }],
      },
    ],
    accounting: { ledger: { ok: true }, latest: null },
    events: [
      {
        timestamp: 6000,
        kind: "STOP",
        code: "PAPER_RECOVERY_EXHAUSTED",
        fatal: false,
        episode: {
          startedAt: 0,
          endedAt: 180000,
          durationMs: 180000,
          failures: 9,
          tally: { "GeckoTerminal/UPSTREAM_HTTP_429": 9 },
        },
      },
    ],
    timing: {},
    ...patch,
  }) as unknown as OperationsSnapshot;

it("formats an episode summary for humans and AI alike", () => {
  expect(
    episodeSummaryText({
      startedAt: 0,
      endedAt: 65000,
      durationMs: 65000,
      failures: 3,
      tally: { "Sui gRPC/UPSTREAM_DNS_FAILED": 1, "GeckoTerminal/UPSTREAM_HTTP_429": 2 },
    }),
  ).toBe(
    "期間 1分5秒・失敗 3 回・内訳： GeckoTerminal/UPSTREAM_HTTP_429 ×2、Sui gRPC/UPSTREAM_DNS_FAILED ×1",
  );
});

it("builds a self-describing report with the episode evidence inline", () => {
  const report = buildDiagnosticReport(snapshot(), 100000);
  expect(report).toContain("# SuiBa 診断レポート（AI調査用）");
  expect(report).toContain("status: ABNORMAL_STOP");
  expect(report).toContain("Bot abc1234");
  expect(report).toContain("stopReason: PAPER_RECOVERY_EXHAUSTED");
  expect(report).toContain("GeckoTerminal/UPSTREAM_HTTP_429 ×9");
  expect(report).toContain("進行中のエピソード: なし");
  expect(report).toContain("ledger ok: true");
});

it("includes the execution environment when the worker provides it", () => {
  const report = buildDiagnosticReport(
    snapshot({
      environment: {
        mode: "PAPER",
        pair: "SUI_USDC",
        provider: "GeckoTerminal",
        paperCheck: { enabled: true, armed: true, expired: false, expires: 90000 },
        maintenance: false,
      },
    }),
    100000,
  );
  expect(report).toContain("## 実行環境");
  expect(report).toContain("pair: SUI_USDC / 市場プロバイダ: GeckoTerminal");
  expect(report).toContain("paper-check: 検証中");
  expect(report).toContain("maintenance: なし");
});

it("marks the environment unknown for older workers without the block", () => {
  const report = buildDiagnosticReport(snapshot(), 100000);
  expect(report).toContain("## 実行環境");
  expect(report).toContain("paper-check: 不明");
});

it("reports the in-progress episode tally from the safety state", () => {
  const report = buildDiagnosticReport(
    snapshot({
      safety: {
        botState: "DEGRADED",
        connectivity: "DEGRADED",
        resumePending: true,
        episodeAt: 40000,
        failures: 2,
        episodeTally: { "Sui gRPC/UPSTREAM_TIMEOUT": 2 },
        latestApiError: null,
      },
    }),
    100000,
  );
  expect(report).toContain("進行中のエピソード: 期間 1分0秒・失敗 2 回");
  expect(report).toContain("Sui gRPC/UPSTREAM_TIMEOUT ×2");
});
