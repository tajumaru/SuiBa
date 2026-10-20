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
export function presetName(current?: Settings): "safe" | "custom" {
  if (!current) return "safe";
  const safe = applySafePreset(current);
  return presetKeys.every((key) => current[key] === safe[key])
    ? "safe"
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
