export type BotControlState =
  "RUNNING" | "DEGRADED" | "PAUSED" | "STOPPED" | "FAULTED";

/** Canonical operational state; never grants order permission. */
export function botControlState(input: {
  running: boolean;
  error: string | null;
  emergency: boolean;
  databaseHealthy: boolean;
  connectivity: string;
  resumePending: boolean;
  ordersAllowed: boolean;
}): BotControlState {
  if (!input.databaseHealthy || input.error || input.emergency)
    return "FAULTED";
  if (!input.running && !input.resumePending) return "STOPPED";
  if (input.connectivity === "DEGRADED") return "DEGRADED";
  if (input.connectivity !== "HEALTHY" || !input.ordersAllowed) return "PAUSED";
  return "RUNNING";
}
