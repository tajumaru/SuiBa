import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { WorkerStaleNote } from "../apps/dashboard/src/WorkerStaleNote.tsx";
import { StopHistory } from "../apps/dashboard/src/StopHistory.tsx";
import { HistoryTab } from "../apps/dashboard/src/HistoryTab.tsx";
const now = 1_800_000_000_000;
function fixture() {
  const db = new BotDatabase(":memory:");
  const data = new OperationMonitor(db).snapshot(now);
  db.close();
  return data;
}
afterEach(() => vi.useRealTimers());
describe("retired validation tab", () => {
  it("removes the page and dedicated control while leaving the shared operation path", () => {
    const shell = readFileSync("apps/dashboard/src/main.tsx", "utf8");
    expect(shell).not.toContain("OperationsFeedView");
    expect(shell).not.toContain('activeTab === "運用検証"');
    expect(shell).toContain("<OperationBar");
    expect(shell).toContain('api("control", { command, ...extra })');
    expect(shell).toContain('NAV_TABS.includes(tab) ? tab : "Overview"');
    expect(existsSync("apps/dashboard/src/ValidationControl.tsx")).toBe(false);
    expect(existsSync("apps/dashboard/src/OperationsPanel.tsx")).toBe(false);
  });
  it("stays silent for settled states and speaks one line when the feed is stale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const data = fixture();
    // A stopped bot is the operation bar's story, not this note's:
    // the old always-on Worker panel is gone (owner, 2026-11-22).
    expect(renderToStaticMarkup(<WorkerStaleNote data={data} />)).toBe("");
    expect(
      renderToStaticMarkup(<WorkerStaleNote data={data} stale />),
    ).toContain("最新情報を取得できません");
  });
  it("renders nothing while a running worker's evidence is fresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const data = fixture();
    data.status = "RUNNING";
    data.safety.botState = "RUNNING";
    data.safety.connectivity = "HEALTHY";
    data.safety.ordersAllowed = true;
    data.timing.transportRecent = true;
    data.timing.dataStatus = "FRESH";
    data.timing.lastTransportSuccessAt = now - 1000;
    data.timing.lastAnalysisAt = now - 1000;
    data.lastMarketClosedAt = now - 1000;
    data.lastHeartbeatAt = now - 1000;
    expect(renderToStaticMarkup(<WorkerStaleNote data={data} />)).toBe("");
  });
  it("keeps a running worker with old evidence unknown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const data = fixture();
    data.status = "RUNNING";
    data.lastHeartbeatAt = now - 60000;
    expect(renderToStaticMarkup(<WorkerStaleNote data={data} />)).toContain(
      "状態確認中",
    );
  });
  it("renders recorded stops and the released stop reason beside order history", () => {
    const data = fixture();
    data.stopReason = null;
    data.safety.lastStopReason = "MANUAL_STOP";
    data.reports.find((r) => r.hours === 168)!.stopReasons = [
      { timestamp: now - 10000, reason: "PAPER_RECONCILIATION_FAILED" },
    ];
    const html = renderToStaticMarkup(
      <HistoryTab operations={data} orders={[]} trades={[]} candles={[]} />,
    );
    expect(html).toContain("直近の停止理由");
    expect(html).toContain("解除済み");
    expect(html).toContain("<time dateTime=");
    expect(html).toContain("stop-history-period");
    expect(html).toContain("照合");
    expect(html).toContain("注文 / 拒否理由");
    expect(data.reports.find((r) => r.hours === 168)!.stopReasons).toHaveLength(
      1,
    );
  });
  it("distinguishes unavailable, empty and stale history", () => {
    expect(
      renderToStaticMarkup(<StopHistory data={null} error="接続失敗" />),
    ).toContain("停止記録を取得できません");
    const data = fixture();
    data.reports.forEach((r) => (r.stopReasons = []));
    expect(renderToStaticMarkup(<StopHistory data={data} />)).toContain(
      "この期間の停止記録はありません",
    );
    expect(
      renderToStaticMarkup(
        <StopHistory data={data} error="最新情報ではありません" />,
      ),
    ).toContain("最新情報ではありません");
  });
});
