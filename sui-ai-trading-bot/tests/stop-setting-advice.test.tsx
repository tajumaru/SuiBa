import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BotEngine } from "../apps/worker/src/engine.ts";
import { defaults } from "../packages/shared/src/index.ts";
import { stopSettingAdvice } from "../apps/dashboard/src/stopSettingAdvice.ts";
import { StopReleaseSection } from "../apps/dashboard/src/SettingsPage.tsx";
type State = ReturnType<BotEngine["snapshot"]>;
const now = 1_800_000_000_000;
function snapshot(error = "THIN_ORDERBOOK", mode = "PAPER"): State {
  return {
    mode,
    runtime: { running: false, emergency: false, error },
    settings: { ...defaults, maxOrder: 5 },
    marketData: {
      diagnostics: {
        bookObservation: {
          timestamp: now - 1000,
          fetchedAt: now - 900,
          maxSpread: defaults.maxSlippage,
        },
        bidDepthUsdc: 0.03,
        askDepthUsdc: 0.04,
      },
    },
  } as unknown as State;
}
describe("actionable stop-setting advice", () => {
  it("names the exact setting and reports the smaller side of a fresh book", () => {
    const advice = stopSettingAdvice(snapshot(), now)!;
    expect(advice.message).toContain("5 USDC");
    expect(advice.action).toContain("「1回の最大取引額」を小さくして保存");
    expect(advice.observation).toContain("約0.03 USDC");
    expect(advice.constraints).toContain("最低注文量や手数料");
  });
  it.each([now + 10_001, now - 2000])(
    "does not present old or future observations as available amounts (%s)",
    (at) => {
      expect(stopSettingAdvice(snapshot(), at)!.observation).toBeNull();
    },
  );
  it("does not reuse a depth measured against different price limits", () => {
    const data = snapshot();
    data.settings.maxSlippage = 0.001;
    expect(stopSettingAdvice(data, now)!.observation).toBeNull();
  });
  it("distinguishes wide spreads and does not recommend raising safety limits", () => {
    const advice = stopSettingAdvice(snapshot("SPREAD_TOO_WIDE"), now)!;
    expect(advice.message).toContain("0.3%");
    expect(advice.action).toContain("注文額を減らしても解決しません");
    expect(advice.field).toBeNull();
  });
  it("does not suggest changing trade amounts for emergency or network failures", () => {
    const emergency = snapshot();
    emergency.runtime.emergency = true;
    expect(stopSettingAdvice(emergency, now)).toBeNull();
    expect(stopSettingAdvice(snapshot("UPSTREAM_TIMEOUT"), now)).toBeNull();
  });
  it("renders an entry point to the relevant setting without changing it", () => {
    const data = snapshot();
    const original = JSON.stringify(data);
    const html = renderToStaticMarkup(
      <StopReleaseSection
        data={data}
        control={async () => null}
        onReviewSettings={() => {}}
      />,
    );
    expect(html).toContain("取引額の設定を開く");
    expect(html).toContain("詳しい条件");
    expect(html).not.toContain("安全停止中です。停止理由：");
    expect(JSON.stringify(data)).toBe(original);
  });
});

describe("stop release panel by mode", () => {
  const render = (data: State) =>
    renderToStaticMarkup(
      <StopReleaseSection data={data} control={async () => null} />,
    );
  it("offers the dashboard reset in PAPER", () => {
    const html = render(snapshot("DATA_OR_EXECUTION_FAILURE"));
    expect(html).toContain("停止を解除");
  });
  it("adds only the detail line when the stop has a recorded detail", () => {
    const data = snapshot("DATA_OR_EXECUTION_FAILURE", "REAL");
    const original = render(data);
    expect(original).not.toContain("詳細：");
    data.runtime.failureDetail = "Unexpected <response> format";
    const line = "<p>詳細：Unexpected &lt;response&gt; format</p>";
    const updated = render(data);
    expect(updated).toContain(line);
    expect(updated.replace(line, "")).toBe(original);
  });
  it("shows no release button in REAL and points at the PC approval procedure", () => {
    const html = render(snapshot("DATA_OR_EXECUTION_FAILURE", "REAL"));
    expect(html).not.toContain("停止を解除");
    expect(html).toContain("この画面からは解除できません");
    expect(html).toContain("再開はPCでの承認手順が必要です");
    expect(html).toContain("データ取得または処理でエラーが発生しました");
    expect(html).not.toContain("PAPER処理");
  });
  it("keeps the emergency clear in REAL but says it does not resume trading", () => {
    const data = snapshot("DATA_OR_EXECUTION_FAILURE", "REAL");
    data.runtime.emergency = true;
    const html = render(data);
    expect(html).toContain("緊急停止を解除");
    expect(html).toContain("解除してもREAL運用は再開しません");
  });
});
