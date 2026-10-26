/**
 * The header character's error shout: a pure mapping from the
 * safety snapshot — the same record the connectivity displays
 * derive from, so the shout can never disagree with them — to a
 * short, fixed outburst. Only genuine error states shout:
 * a latched emergency or safety stop, a stale display (the
 * latest state cannot be confirmed), and a degraded connection.
 * Recovering, paused and healthy states stay quiet; the wording
 * is fixed per kind and carries no invented detail. The label is
 * the state wording the rest of the app already uses.
 */
export interface ErrorShout {
  kind: "emergency" | "abnormal" | "unknown" | "connectivity";
  label: string;
  message: string;
}

/** The two safety fields the shout reads, structurally typed. */
export interface SafetyLike {
  botState: string;
  connectivity: string;
}

export function errorShout(
  safety: SafetyLike | null,
  stale: boolean,
): ErrorShout | null {
  // Latched stops are facts even in a stale snapshot: the bot
  // stays stopped until a human releases it.
  if (safety?.botState === "EMERGENCY_STOP")
    return {
      kind: "emergency",
      label: "緊急停止中",
      message: "止まってるよ！",
    };
  if (safety?.botState === "ABNORMAL_STOP")
    return {
      kind: "abnormal",
      label: "安全停止中",
      message: "止まっちゃった！",
    };
  // A stale display cannot vouch for anything fresher, so it
  // outranks the (also stale) connectivity reading below.
  if (stale)
    return {
      kind: "unknown",
      label: "状態不明",
      message: "様子がわからない！",
    };
  if (safety?.connectivity === "DEGRADED")
    return {
      kind: "connectivity",
      label: "通信障害",
      message: "つながらない…！",
    };
  return null;
}
