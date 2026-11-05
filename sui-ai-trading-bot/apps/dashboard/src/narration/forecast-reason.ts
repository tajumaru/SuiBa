import type { ForecastRecord } from "../forecastLog.ts";
import type { DecisionTelemetry } from "../../../worker/src/operations.ts";
import { freshDecision } from "./state.ts";

/**
 * The recorded facts behind a forecast declaration — the
 * character thinking out loud. Built ONLY from the latest fresh
 * decision evidence and the forecast's own record (its book-tilt
 * share), naming up to three facts that point the declared way.
 * Facts pointing the other way are never dressed up as support,
 * and when nothing on the record supports the direction the
 * declaration stands on the model's drift alone (null here, and
 * the call text stays plain). Display only, like the forecast
 * itself; nothing here feeds any decision.
 */
export function forecastReasonText(
  rec: ForecastRecord,
  dec: DecisionTelemetry | null | undefined,
  now: number,
): string | null {
  if (!dec || rec.dir === "flat" || !freshDecision(dec, now)) return null;
  const facts: string[] = [];
  if (rec.dir === "up") {
    if (dec.conditions.rsiRecovery) facts.push("RSIは回復しつつある");
    else if (dec.rsi <= dec.oversold + 5)
      facts.push("RSIは売られすぎ圏にある");
    else if (dec.rsi > dec.previousRsi) facts.push("RSIは上向き");
    if (dec.conditions.histogramImproving) facts.push("MACDも上向き");
    if (dec.ema20 > dec.ema50) facts.push("EMAは上向きの並び");
    if (rec.tilt != null && rec.tilt > 0) facts.push("板の買いが後押し");
  } else {
    if (dec.rsi >= dec.overbought - 5)
      facts.push("RSIは買われすぎ圏にある");
    else if (dec.rsi < dec.previousRsi) facts.push("RSIは下向き");
    if (dec.histogram < dec.previousHistogram) facts.push("MACDも下向き");
    if (dec.ema20 < dec.ema50) facts.push("EMAは下向きの並び");
    if (rec.tilt != null && rec.tilt < 0) facts.push("板の売りが後押し");
  }
  return facts.length > 0 ? facts.slice(0, 3).join("、") : null;
}
