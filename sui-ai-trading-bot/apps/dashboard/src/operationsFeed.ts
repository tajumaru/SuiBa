import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsApi } from "./settingsPresets.ts";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import type { ControlState } from "./validationControl.ts";
import { errorCode } from "./presentation.ts";

export type OperationsFeed = ReturnType<typeof useOperationsFeed>;

/**
 * The single operations polling loop (operations snapshot + control
 * state every 10 seconds). It lives at the App level so the agent
 * narration tab and the operations tab share one feed: the narration
 * history, which is accumulated from snapshot diffs, keeps advancing
 * no matter which tab is on screen, and the endpoints are never
 * polled twice.
 *
 * Extracted from OperationsPanel so the app shell can hold the feed
 * without statically loading the operations tab's panels; the view
 * side loads lazily with its tab.
 */
export function useOperationsFeed(api: SettingsApi, active: boolean) {
  const [data, setData] = useState<OperationsSnapshot | null>(null),
    [state, setState] = useState<ControlState | undefined>(),
    [error, setError] = useState("");
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!active) {
      setData(null);
      setState(undefined);
      setError("");
      return;
    }
    let alive = true;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const response = await Promise.race([
          Promise.all([api("operations"), api("state")]),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("OPERATIONS_TIMEOUT")),
              8000,
            );
          }),
        ]);
        if (alive && request === generation) {
          const [operations, current] = response;
          setData(operations as OperationsSnapshot);
          setState(current as ControlState);
          setError("");
        }
      } catch (e) {
        if (alive && request === generation)
          setError(
            "運用検証データを取得できません。表示済みの情報は最新とは限りません。接続状態を確認してください。コード：" +
              errorCode(e),
          );
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    };
    refreshRef.current = refresh;
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, active]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { data, state, error, refresh };
}
