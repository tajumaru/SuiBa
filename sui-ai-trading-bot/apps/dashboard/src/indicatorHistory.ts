import { useEffect, useState } from "react";
import type { DecisionTelemetry } from "../../worker/src/operations.ts";
import {
  appendIndicatorPoint,
  type IndicatorPoint,
} from "./strategyView.ts";

/**
 * Accumulates the short indicator history the strategy mini charts
 * draw, one point per new decision. It lives at the App level (like
 * the narration state) so switching tabs does not erase what the
 * client has actually seen; points are appended only from recorded
 * decision evidence, never synthesised.
 *
 * Extracted from StrategyPanel so the app shell can hold the history
 * without statically loading the strategy tab's panels; the panel
 * loads lazily with its tab.
 */
export function useIndicatorHistory(
  decision: DecisionTelemetry | null | undefined,
) {
  const [history, setHistory] = useState<IndicatorPoint[]>([]);
  useEffect(() => {
    setHistory((h) => appendIndicatorPoint(h, decision, Date.now()));
  }, [decision]);
  return history;
}
