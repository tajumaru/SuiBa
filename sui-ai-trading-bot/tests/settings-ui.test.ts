import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
import { defaults, settingsSchema } from "../packages/shared/src/index.ts";
import {
  applySafePreset,
  presetName,
  presetKeys,
  saveSettings,
} from "../apps/dashboard/src/settingsPresets.ts";
import {
  SettingsPage,
  ProfitGuardSummary,
  AdvancedSettings,
  PresetSelector,
  fields,
} from "../apps/dashboard/src/SettingsPage.tsx";
import { BotDatabase } from "../packages/database/src/index.ts";

describe("かんたん設定", () => {
  it("offers safe for a new UI and identifies persisted custom values without changing defaults", () => {
    expect(presetName()).toBe("safe");
    expect(presetName(defaults)).toBe("custom");
    expect(defaults.maxOrder).toBe(5);
    expect(presetName(applySafePreset(defaults))).toBe("safe");
  });
  it("selection is a pure render and never saves or starts", () => {
    const change = vi.fn();
    const html = renderToStaticMarkup(
      React.createElement(PresetSelector, { value: "safe", onChange: change }),
    );
    expect(html).toContain('aria-pressed="true"');
    expect(change).not.toHaveBeenCalled();
  });
  it("applies only preset keys, keeps strict risk settings, validates units and preserves source", () => {
    const current = {
      ...defaults,
      stopLossPct: 0.013,
      dailyLossPct: 0.002,
      maxHoldingRatio: 0.04,
      maxSlippage: 0.001,
      gasUsdc: 0.06,
    };
    const copy = { ...current },
      safe = applySafePreset(current);
    expect(current).toEqual(copy);
    expect(safe).toMatchObject({
      maxOrder: 2,
      dailyBuyLimit: 10,
      minNetProfitUsdc: 0.05,
      minNetProfitPct: 0.015,
      profitGuardEnabled: true,
      maxSlippage: 0.001,
    });
    for (const key of Object.keys(current) as (keyof typeof current)[])
      if (!presetKeys.includes(key as (typeof presetKeys)[number]))
        expect(safe[key]).toBe(current[key]);
    expect(settingsSchema.safeParse(safe).success).toBe(true);
    expect(
      applySafePreset({ ...defaults, profitGuardEnabled: false })
        .profitGuardEnabled,
    ).toBe(true);
  });
  it("sends the complete validated object and rereads state without control calls", async () => {
    const safe = applySafePreset(defaults);
    const api = vi
      .fn()
      .mockResolvedValueOnce(safe)
      .mockResolvedValueOnce({ settings: safe });
    expect(await saveSettings(api, safe)).toEqual(safe);
    expect(api.mock.calls).toEqual([["settings", safe], ["state"]]);
  });
  it("rejects invalid settings before making a request", async () => {
    const api = vi.fn();
    await expect(
      saveSettings(api, { ...defaults, maxOrder: 6 }),
    ).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });
  it.each(["post", "read", "mismatch"])(
    "does not report success on %s failure",
    async (stage) => {
      const safe = applySafePreset(defaults),
        api = vi.fn();
      if (stage === "post") api.mockRejectedValueOnce(new Error("offline"));
      else api.mockResolvedValueOnce(safe);
      if (stage === "read") api.mockRejectedValueOnce(new Error("offline"));
      if (stage === "mismatch")
        api.mockResolvedValueOnce({ settings: defaults });
      await expect(saveSettings(api, safe)).rejects.toThrow();
    },
  );
  it("retains runtime and paper trade history when saving settings", () => {
    const db = new BotDatabase(":memory:");
    db.append("paper_trades", "existing", { orderId: "existing" }, 1);
    const runtime = db.runtime(),
      history = db.history("paper_trades");
    db.updateSettings(applySafePreset(db.settings()));
    expect(db.runtime()).toEqual(runtime);
    expect(db.runtime().running).toBe(false);
    expect(db.history("paper_trades")).toEqual(history);
  });
  it("keeps every schema field editable or fixed and advanced settings collapsed", () => {
    expect(
      new Set([...fields.map((f) => f.key), "strategy", "profitGuardEnabled"]),
    ).toEqual(new Set(Object.keys(defaults)));
    const html = renderToStaticMarkup(
      React.createElement(AdvancedSettings, {
        draft: defaults,
        setDraft: () => {},
      }),
    );
    expect(html).toContain("<details>");
    expect(html).not.toContain("<details open");
    expect(html).toContain("MACD");
  });
});

it("renders a custom saved configuration without saving or starting", () => {
  const api = vi.fn(),
    control = vi.fn(),
    onSaved = vi.fn();
  const data = {
    settings: defaults,
    runtime: { running: false, emergency: false, error: null },
    profitGuard: null,
  } as unknown as Parameters<typeof SettingsPage>[0]["data"];
  const html = renderToStaticMarkup(
    React.createElement(SettingsPage, { data, api, control, onSaved }),
  );
  expect(html).toContain("保存済み：カスタム");
  expect(html).toContain("PAPER運用開始");
  expect(html).toContain("データ不足");
  expect(html).not.toContain("<details open");
  expect(api).not.toHaveBeenCalled();
  expect(control).not.toHaveBeenCalled();
});
it.each([
  ["MINIMUM_NET_PROFIT_NOT_MET", false, "利益不足で見送り", "手数料込みの利益"],
  ["QUOTE_EXPIRED", false, "データ不足", "価格情報が古い"],
  ["MINIMUM_NET_PROFIT_MET", true, "取引許可", "最低利益を満たしました"],
])(
  "shows a Japanese Profit Guard reason for %s",
  (reason, allowed, status, detail) => {
    const data = {
      settings: applySafePreset(defaults),
      profitGuard: { reason, allowed },
    } as unknown as Parameters<typeof ProfitGuardSummary>[0]["data"];
    const html = renderToStaticMarkup(
      React.createElement(ProfitGuardSummary, { data }),
    );
    expect(html).toContain(status);
    expect(html).toContain(detail);
    expect(html).toContain("1.5");
  },
);

it.each([defaults, { ...defaults, maxOrder: 3, gasUsdc: 0.08 }])(
  "shows a non-modal recommendation for default and existing custom settings without guessing first use",
  (settings) => {
    const api = vi.fn(),
      control = vi.fn();
    const data = {
      settings,
      runtime: { running: false, emergency: false, error: null },
      profitGuard: null,
    } as unknown as Parameters<typeof SettingsPage>[0]["data"];
    const html = renderToStaticMarkup(
      React.createElement(SettingsPage, {
        data,
        api,
        control,
        onSaved: async () => {},
      }),
    );
    expect(html).toContain("安全重視をおすすめ");
    expect(html).toContain("安全重視の設定を確認する");
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain("適用済み：");
    expect(api).not.toHaveBeenCalled();
    expect(control).not.toHaveBeenCalled();
  },
);
