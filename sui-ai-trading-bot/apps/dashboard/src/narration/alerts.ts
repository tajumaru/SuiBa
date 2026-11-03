import type { DecisionTelemetry } from "../../../worker/src/operations.ts";
import type { SpikeAlert } from "./state.ts";
import { volumeMultiple } from "./decision.ts";
import { signedPct } from "./format.ts";

/** Spike alerts compare the current decision price against the one
 * this many narrated cycles back. */
export const ALERT_PRICE_LOOKBACK = 3;
/** A price move of at least this ratio (±1%) against the look-back
 * price is alert-worthy. */
export const ALERT_PRICE_THRESHOLD = 0.01;
/**
 * The recorded volume change is a ratio — the newest candle's
 * volume over the previous one's, minus one (see the indicators
 * package) — so this volume-spike threshold of 2 means the change
 * `fmtPercent` would print as +200%.
 */
export const ALERT_VOLUME_THRESHOLD = 2;
/** After an alert fires, this many narrated cycles pass before the
 * next one may fire. Counted in decision cycles, never in polls. */
export const ALERT_COOLDOWN_CYCLES = 5;
/** Price points kept for the alert look-back (only the newest
 * ALERT_PRICE_LOOKBACK + 1 are ever consulted). */
export const ALERT_HISTORY_KEEP = 12;

/**
 * Alert price moves always print with exactly one decimal place
 * ("+1.8%", "-1.0%"). The volume change inside an alert keeps the
 * feed's existing volume style (`signedPct`: "+250%", "+350%"),
 * the same shape the VOLUME_REJECT line already prints — except
 * when the recorded change is huge, where both lines switch to a
 * multiple instead (see `volumeMultiple`).
 */
export const alertPct = (ratio: number) =>
  `${ratio > 0 ? "+" : ""}${new Intl.NumberFormat("ja-JP", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(ratio)}`;

/**
 * Detect a spike worth breaking in for, from the recorded evidence
 * alone: the decision prices of the narrated cycles before this one
 * (`history`, oldest first, not yet including `dec`) and this
 * cycle's own decision. Returns null — silence — when:
 * - the price history has not warmed up (fewer than
 *   ALERT_PRICE_LOOKBACK earlier points, so no four-point move can
 *   be stated);
 * - the price or volume change is missing, non-finite, or unusable;
 * - neither the ±1% price move nor the +200% volume change fired.
 * When the price and the volume spike in the same cycle the alert is
 * a single entry mentioning both. A volume spike the cycle's own
 * narration already reports (a VOLUME_REJECT cycle prints the change
 * itself) is never repeated: on such a cycle only a price move can
 * still alert, and its text leaves the volume out.
 */
export function spikeAlert(
  history: readonly number[],
  dec: DecisionTelemetry,
): SpikeAlert | null {
  if (history.length < ALERT_PRICE_LOOKBACK) return null;
  if (!Number.isFinite(dec.price) || dec.price <= 0) return null;
  const base = history[history.length - ALERT_PRICE_LOOKBACK];
  if (!Number.isFinite(base) || base <= 0) return null;
  const ratio = dec.price / base - 1;
  const priceUp = ratio >= ALERT_PRICE_THRESHOLD;
  const priceDown = ratio <= -ALERT_PRICE_THRESHOLD;
  const volumeSpike =
    Number.isFinite(dec.volumeChange) &&
    dec.volumeChange >= ALERT_VOLUME_THRESHOLD &&
    dec.selectedRule !== "VOLUME_REJECT";
  if (!priceUp && !priceDown && !volumeSpike) return null;
  if (priceUp)
    return {
      direction: "up",
      text: volumeSpike
        ? `急上昇。価格が${alertPct(ratio)}。売買も急増しているよ`
        : `急上昇。価格が${alertPct(ratio)}になったよ`,
    };
  if (priceDown)
    return {
      direction: "down",
      text: volumeSpike
        ? `急落注意。価格が${alertPct(ratio).slice(1)}下がったよ。売買も急増しているよ`
        : `急落注意。価格が${alertPct(ratio).slice(1)}下がったよ`,
    };
  const multiple = volumeMultiple(dec.volumeChange);
  return {
    direction: "volume",
    text:
      multiple != null
        ? `売買が約${multiple}倍に急増しているよ。値動きに注意`
        : Number.isFinite(dec.volumeChange)
          ? `売買が急増しているよ（${signedPct(dec.volumeChange)}）。値動きに注意`
          : `売買が急増しているよ。値動きに注意`,
  };
}
