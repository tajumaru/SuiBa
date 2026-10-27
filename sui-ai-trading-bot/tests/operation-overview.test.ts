import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotDatabase } from "../packages/database/src/index.ts";
import { OperationMonitor } from "../apps/worker/src/operations.ts";
import {
  noTradeReasons,
  operationSummary,
  OperationSummary,
} from "../apps/dashboard/src/OperationOverview.tsx";
describe("operation overview evidence", () => {
  function fixture() {
    const db = new BotDatabase(":memory:");
    const d = new OperationMonitor(db).snapshot();
    db.close();
    return d;
  }
  it("never labels stale or stopped PAPER healthy", () => {
    const d = fixture();
    expect(operationSummary(d).title).not.toBe("正常稼働");
    expect(operationSummary(d, true).title).toBe("状態取得失敗");
  });
  it("distinguishes safety stop and recovery", () => {
    const d = fixture();
    d.status = "ABNORMAL_STOP";
    expect(operationSummary(d).title).toBe("停止中");
    d.status = "RUNNING";
    d.safety.botState = "RUNNING";
    d.safety.connectivity = "RECOVERING";
    expect(operationSummary(d).title).toBe("通信確認中");
    d.safety.connectivity = "DEGRADED";
    expect(operationSummary(d).title).toBe("通信異常");
  });
  it("requires fresh communication and order permission for healthy", () => {
    const d = fixture();
    d.status = "RUNNING";
    d.safety.botState = "RUNNING";
    d.safety.connectivity = "HEALTHY";
    d.safety.ordersAllowed = true;
    d.timing.dataStatus = "FRESH";
    d.timing.transportRecent = true;
    expect(operationSummary(d).title).toBe("正常稼働");
    d.safety.ordersAllowed = false;
    expect(operationSummary(d).title).toBe("通信確認中");
  });
  it("does not turn a successful read with a closed order gate into a retrieval failure", () => {
    const d = fixture();
    d.status = "RUNNING";
    d.safety.botState = "HEALTHY";
    d.safety.ordersAllowed = false;
    const html = renderToStaticMarkup(
      React.createElement(OperationSummary, { data: d, stale: false }),
    );
    expect(html).toContain("注文に必要なデータ・安全条件を確認");
    expect(html).not.toContain("最新のBot状態を取得できません");
  });
  it("keeps multiple reasons and period-specific skip evidence", () => {
    const d = fixture();
    d.reports[0].profitGuardSkipped = 2;
    d.reports[0].riskSkipped = 1;
    const r = noTradeReasons(d, 24);
    expect(r.some((x) => x.includes("利益保護"))).toBe(true);
    expect(r.some((x) => x.includes("リスク制限"))).toBe(true);
    expect(noTradeReasons(d, 168).some((x) => x.includes("利益保護"))).toBe(
      false,
    );
    d.reports[0].tradeCount = 1;
    expect(noTradeReasons(d, 24)).toEqual([]);
  });
  it("does not infer unmet strategy conditions from zero candidates", () => {
    const d = fixture();
    d.status = "RUNNING";
    d.timing.transportRecent = true;
    d.timing.dataStatus = "FRESH";
    expect(noTradeReasons(d, 24)).toEqual([
      "原因未確定：候補0件だけでは売買条件の不成立を断定できません",
    ]);
  });
});
