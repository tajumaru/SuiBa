import { describe, expect, it } from "vitest";
import { validationFixture } from "./deepbook-ui-fixture.ts";
import { validationControl } from "../apps/dashboard/src/validationControl.ts";
const go = { status: "GO", reason: "test only" } as const;
function ready(
  scenario:
    "unstarted" | "stopped" | "running" | "safety-stop" | "passed" = "stopped",
) {
  const f = validationFixture(scenario);
  f.state.connection.checkedAt = Date.now();
  return f;
}
describe("operation control safety and sequence", () => {
  it("defaults to the reviewed NO-GO, even with healthy APIs", () => {
    const f = ready();
    const v = validationControl(f.operations, f.state);
    expect(v.measureReasons.join()).toContain("NO-GO");
    expect(v.startReasons.join()).toContain("NO-GO");
    expect(v.tone).toBe("stopped");
  });
  it("allows measurement first, then a separate manual PAPER start", () => {
    const f = ready("unstarted");
    expect(
      validationControl(f.operations, f.state, false, go).measureReasons,
    ).toEqual([]);
    expect(
      validationControl(f.operations, f.state, false, go).startReasons.join(),
    ).toContain("先にステップ1");
    const started = ready();
    expect(
      validationControl(started.operations, started.state, false, go)
        .startReasons,
    ).toEqual([]);
    expect(
      validationControl(
        started.operations,
        started.state,
        false,
        go,
      ).measureReasons.join(),
    ).toContain("開始済み");
  });
  it.each(["running", "safety-stop", "passed"] as const)(
    "preserves %s state",
    (scenario) => {
      const f = ready(scenario);
      const before = JSON.stringify(f);
      const v = validationControl(f.operations, f.state, false, go);
      expect(v.measureReasons.length).toBeGreaterThan(0);
      if (scenario !== "passed")
        expect(v.startReasons.length).toBeGreaterThan(0);
      expect(v.tone).toBe(
        scenario === "running"
          ? "healthy"
          : scenario === "safety-stop"
            ? "danger"
            : "ready",
      );
      expect(JSON.stringify(f)).toBe(before);
    },
  );
  it.each([
    "stale",
    "missing-state",
    "guard",
    "sui",
    "backoff",
    "ledger",
    "fetch",
    "recovery",
    "emergency",
    "live",
  ])("blocks start for %s with a remedy", (kind) => {
    const f = ready();
    if (kind === "guard") f.state.settings.profitGuardEnabled = false;
    if (kind === "sui") f.state.connection.checkedAt = 0;
    if (kind === "backoff")
      f.operations.apis = [
        { backoff: true } as (typeof f.operations.apis)[number],
      ];
    if (kind === "ledger") f.operations.accounting.ledger.ok = false;
    if (kind === "fetch") f.operations.timing.fetchElapsedMs = 45001;
    if (kind === "recovery") {
      f.operations.safety.connectivity = "RECOVERING";
      f.operations.safety.resumePending = true;
    }
    if (kind === "emergency") f.state.runtime.emergency = true;
    if (kind === "live") f.state.mode = "LIVE";
    expect(
      validationControl(
        f.operations,
        kind === "missing-state" ? undefined : f.state,
        kind === "stale",
        go,
      ).startReasons.length,
    ).toBeGreaterThan(0);
  });
});
