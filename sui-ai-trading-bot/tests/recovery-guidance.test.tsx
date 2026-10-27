import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BotDatabase } from "../packages/database/src/index.ts";
import { BotEngine } from "../apps/worker/src/engine.ts";
import { initialPaperSafety } from "../packages/shared/src/paper-recovery.ts";
import { recoveryStatus } from "../apps/dashboard/src/recoveryState.ts";
import { OperationBar } from "../apps/dashboard/src/OperationBar.tsx";

function fixture() {
  const db = new BotDatabase(":memory:");
  const health = { healthy: true, checkedAt: Date.now(), failures: 0 };
  const engine = new BotEngine(
    db,
    { candles: async () => [] },
    {
      getQuote: async () => {
        throw Error("NO_ORDER");
      },
      validateQuote: async () => false,
    },
    { health: async () => health, status: health },
  );
  const state = engine.snapshot();
  db.close();
  return state;
}

describe("recovery guidance grounded in backend safety", () => {
  it.each(["DEGRADED", "RECOVERING"] as const)(
    "blocks a stopped %s bot and distinguishes automatic and manual recovery",
    (connectivity) => {
      const state = fixture();
      state.safety = {
        ...state.safety,
        ...initialPaperSafety(),
        connectivity,
        resumePending: true,
      };
      const automatic = recoveryStatus(state);
      expect(automatic.title).toBe(
        connectivity === "DEGRADED" ? "通信異常" : "通信確認中",
      );
      expect(automatic.canStart).toBe(false);
      expect(automatic.automatic).toBe(true);
      expect(automatic.next).toContain("自動復旧を待って");
      state.safety.resumePending = false;
      const manual = recoveryStatus(state);
      expect(manual.canStart).toBe(false);
      expect(manual.automatic).toBe(false);
      expect(manual.next).toContain("手動で開始");
      expect(manual.next).toContain("自動再開しません");
    },
  );

  it("offers manual start only on a fresh healthy PAPER stop", () => {
    const state = fixture();
    expect(recoveryStatus(state)).toMatchObject({
      title: "停止中",
      canStart: true,
    });
    for (const blocked of [
      recoveryStatus(state, true),
      recoveryStatus(state, false, true),
      recoveryStatus({ ...state, mode: "LIVE" }),
      recoveryStatus({
        ...state,
        safety: { ...state.safety, resumePending: true },
      }),
    ])
      expect(blocked.canStart).toBe(false);
  });

  it("does not infer a communication fault, stopped bot or closed backend order gate from a failed read", () => {
    const state = fixture();
    state.safety.connectivity = "DEGRADED";
    const v = recoveryStatus(state, true);
    expect(v.title).toBe("状態取得失敗");
    expect(v.reason).toContain("通信異常かどうかは未確認");
    expect(v.safety).toContain("稼働・注文可否は未確認");
    expect(v.canStart).toBe(false);
    expect(v.automatic).toBe(false);
    expect(recoveryStatus(null).title).toBe("通信確認中");
    expect(recoveryStatus(null, true).title).toBe("状態取得失敗");
  });

  it.each(["emergency", "error"] as const)(
    "requires diagnosis and explicit release after %s, even with recovered connectivity",
    (kind) => {
      const state = fixture();
      if (kind === "emergency") state.runtime.emergency = true;
      else state.runtime.error = "PAPER_RECONCILIATION_FAILED";
      const v = recoveryStatus(state);
      expect(v.title).toBe("停止中");
      expect(v.canStart).toBe(false);
      expect(v.next).toContain("解除の手順へ");
      expect(v.safety).toContain("自動再開しません");
    },
  );

  it("requires running and backend order permission before claiming normal operation", () => {
    const state = fixture();
    state.runtime.running = true;
    state.safety.botState = "HEALTHY";
    expect(recoveryStatus(state).title).toBe("通信確認中");
    state.safety.ordersAllowed = true;
    expect(recoveryStatus(state).title).toBe("正常稼働");
    expect(recoveryStatus(state, true).title).toBe("状態取得失敗");
  });

  it("keeps the bar start pressable while recovering; the server stays the gate", () => {
    const state = fixture();
    state.safety.connectivity = "RECOVERING";
    const status = recoveryStatus(state);
    expect(status.canStart).toBe(false);
    const html = renderToStaticMarkup(
      <OperationBar
        runtime={state.runtime}
        recovery={status}
        control={async () => null}
        startBlocked={[]}
        onOpenStrategy={() => {}}
      />,
    );
    // Icon-only button, not disabled by the recovery status: pressing
    // it asks the server, whose refusal reason renders under the bar.
    expect(html).toMatch(/aria-label="PAPER運用開始"(?!disabled)/);
    expect(html).not.toContain("recovery-start-block");
    expect(html).toContain("PAPER運用：通信確認中");
  });
});
