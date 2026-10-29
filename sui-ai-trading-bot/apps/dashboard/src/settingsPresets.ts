import {
  settingsSchema,
  type Settings,
} from "../../../packages/shared/src/index.ts";
export const presetKeys = [
  "maxOrder",
  "dailyBuyLimit",
  "maxSlippage",
  "profitGuardEnabled",
  "minNetProfitUsdc",
  "minNetProfitPct",
] as const;
export function applySafePreset(current: Settings): Settings {
  return settingsSchema.parse({
    ...current,
    maxOrder: 2,
    dailyBuyLimit: 10,
    maxSlippage: Math.min(current.maxSlippage, 0.003),
    profitGuardEnabled: true,
    minNetProfitUsdc: 0.05,
    minNetProfitPct: 0.015,
  });
}
export const hardPresetKeys = [
  "maxOrder",
  "dailyBuyLimit",
  "maxSlippage",
  "profitGuardEnabled",
  "minNetProfitUsdc",
  "minNetProfitPct",
  "oversold",
  "emaGapShrinkEnabled",
  "takeProfitPct",
  "stopLossPct",
] as const;
// Hard mode trades often and rough: the ProfitGuard minimums drop
// to the floor, the EMA gap-shrink route opens entries before the
// trend is confirmed, and tight take-profit / stop-loss levels make
// positions turn over on small moves. The rails stay on — the guard
// itself (including its round-trip cost condition), the daily loss
// limit and the holding-ratio cap are not part of the bundle.
export function applyHardPreset(current: Settings): Settings {
  return settingsSchema.parse({
    ...current,
    maxOrder: 5,
    dailyBuyLimit: 20,
    maxSlippage: 0.003,
    profitGuardEnabled: true,
    minNetProfitUsdc: 0.01,
    minNetProfitPct: 0.005,
    oversold: 45,
    emaGapShrinkEnabled: true,
    takeProfitPct: 0.015,
    stopLossPct: 0.01,
  });
}
export function presetName(current?: Settings): "safe" | "hard" | "custom" {
  if (!current) return "safe";
  const safe = applySafePreset(current);
  if (presetKeys.every((key) => current[key] === safe[key])) return "safe";
  const hard = applyHardPreset(current);
  return hardPresetKeys.every((key) => current[key] === hard[key])
    ? "hard"
    : "custom";
}
export type SettingsApi = (path: string, body?: unknown) => Promise<unknown>;
export async function saveSettings(
  api: SettingsApi,
  candidate: Settings,
): Promise<Settings> {
  const validated = settingsSchema.parse(candidate);
  await api("settings", validated);
  const state = await api("state");
  if (!state || typeof state !== "object" || !("settings" in state))
    throw new Error("設定の再取得に失敗しました");
  const saved = settingsSchema.parse(state.settings);
  if (
    Object.keys(validated).some(
      (key) =>
        validated[key as keyof Settings] !== saved[key as keyof Settings],
    )
  )
    throw new Error("設定の再確認に失敗しました");
  return saved;
}
