import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsApi } from "./settingsPresets.ts";
import type { OperationsSnapshot } from "./operationsTypes.ts";
import type { ControlState } from "./validationControl.ts";
import { errorCode } from "./presentation.ts";

export type OperationsFeed = ReturnType<typeof useOperationsFeed>;

/**
 * The single operations polling loop (operations snapshot + control
 * state every 10 seconds). It lives at the App level so the agent
 * narration, overview and history tabs share one feed: the narration
 * history, which is accumulated from snapshot diffs, keeps advancing
 * no matter which tab is on screen, and the endpoints are never
 * polled twice.
 *
 * Kept at the app shell after retiring the validation tab; consumers
 * share the same recorded operations and control snapshots.
 */
export function useOperationsFeed(
  api: SettingsApi,
  active: boolean,
  paused = false,
) {
  const [data, setData] = useState<OperationsSnapshot | null>(null),
    [state, setState] = useState<ControlState | undefined>(),
    [error, setError] = useState("");
  const [needsSync, setNeedsSync] = useState(false);
  const needsSyncRef = useRef(false);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!active) {
      setData(null);
      setState(undefined);
      setError("");
      setNeedsSync(false);
      needsSyncRef.current = false;
      return;
    }
    if (paused) {
      setNeedsSync(true);
      needsSyncRef.current = true;
      return;
    }
    let alive = true;
    let generation = 0;
    let pending: Promise<void> | null = null;
    const refresh = async () => {
      if (pending) return pending;
      pending = load().finally(() => {
        pending = null;
      });
      return pending;
    };
    const load = async () => {
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
          setNeedsSync(false);
          needsSyncRef.current = false;
        }
      } catch (e) {
        if (alive && request === generation)
          setError(
            "運用データを取得できません。表示済みの情報は最新とは限りません。接続状態を確認してください。コード：" +
              errorCode(e),
          );
        throw e;
      } finally {
        clearTimeout(timeout);
      }
    };
    refreshRef.current = refresh;
    // On reconnect the summary/channels go first; operations follows later.
    const initial = setTimeout(
      () => void refresh().catch(() => {}),
      needsSyncRef.current ? 3500 : 0,
    );
    const timer = setInterval(() => void refresh().catch(() => {}), 10000);
    return () => {
      alive = false;
      clearTimeout(initial);
      clearInterval(timer);
      refreshRef.current = async () => {};
    };
  }, [api, active, paused]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return { data, state, error, refresh, stale: paused || needsSync || !!error };
}
