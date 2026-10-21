import { describe, it, expect } from "vitest";
import { validationView } from "../apps/dashboard/src/validationView.ts";
import { validationFixture, scenarios } from "./deepbook-ui-fixture.ts";
describe("validation UI status does not conflate session and trading", () => {
  for (const scenario of scenarios)
    it(scenario, () => {
      const { report, operations } = validationFixture(scenario);
      const before = JSON.stringify({ report, operations });
      const view = validationView(report, operations);
      expect(view.passed).toBe(scenario === "passed");
      if (scenario === "stopped") {
        expect(view.sessionLabel).toContain("計測中");
        expect(view.botLabel).toBe("停止中");
        expect(view.action).toContain("手動で開始");
        expect(view.tone).toBe("warning");
      }
      if (scenario === "safety-stop") {
        expect(view.botLabel).toBe("異常停止");
        expect(view.tone).toBe("danger");
        expect(view.action).toContain("原因の解消後");
      }
      if (scenario === "failed")
        expect(view.action).toContain("合格条件を満たしていません");
      if (scenario === "api-error")
        expect(view.connectionLabel).toContain("異常");
      expect(JSON.stringify({ report, operations })).toBe(before);
    });
  it("stale snapshots never claim a current healthy connection or running bot", () => {
    const { report, operations } = validationFixture("running");
    const view = validationView(report, operations, true);
    expect(view.botLabel).toBe("状態不明");
    expect(view.connectionLabel).toBe("状態不明");
    expect(view.tone).toBe("danger");
  });
  it("a partial report cannot pass based on the status string alone", () => {
    const { report, operations } = validationFixture("partial");
    report.status = "合格";
    expect(validationView(report, operations).passed).toBe(false);
  });
});
