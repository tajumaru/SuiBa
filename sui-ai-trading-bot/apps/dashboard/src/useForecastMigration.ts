import { useEffect, useRef } from "react";
import { loadForecastLog } from "./forecastLog.ts";
import { loadForecastCalib } from "./forecastCalib.ts";
import type { SettingsApi } from "./settingsPresets.ts";

/** Retry until acknowledged. Never deletes or overwrites the legacy source.
 * Server content hashes deduplicate retries, tabs and devices. */
export function useForecastMigration(
  pair: string | undefined,
  api: SettingsApi,
) {
  const completed = useRef(new Set<string>());
  useEffect(() => {
    if (!pair || completed.current.has(pair)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        await api("forecast/import", {
          records: loadForecastLog(pair),
          calib: loadForecastCalib(pair),
        });
        if (!cancelled) completed.current.add(pair);
      } catch {
        if (!cancelled) timer = setTimeout(run, 10000);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pair, api]);
}
