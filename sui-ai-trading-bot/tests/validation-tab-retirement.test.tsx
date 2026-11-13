import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import { WorkerFreshness } from "../apps/dashboard/src/WorkerFreshness.tsx";
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
  it("renders heartbeat and analysis evidence without schematic or PAPER explanation cards", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const data = fixture();
    data.lastHeartbeatAt = now - 5000;
    data.timing.lastAnalysisAt = now - 12000;
    const html = renderToStaticMarkup(<WorkerFreshness data={data} />);
    expect(html).toContain("Workerの心拍");
    expect(html).toContain("5秒前");
    expect(html).toContain("最終分析成功");
    expect(html).toContain("12秒前");
    expect(html).not.toMatch(/雫|実資金は使用/);
    expect(
      renderToStaticMarkup(<WorkerFreshness data={data} stale />),
    ).toContain("最新情報を取得できません");
  });
  it("keeps a running worker with old evidence unknown", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const data = fixture();
    data.status = "RUNNING";
    data.lastHeartbeatAt = now - 60000;
    expect(renderToStaticMarkup(<WorkerFreshness data={data} />)).toContain(
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
