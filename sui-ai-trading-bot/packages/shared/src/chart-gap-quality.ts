import type { Candle } from "./index.ts";
import { auditedChartGaps } from "./chart-gap-audit.ts";
import { gapCauseLabels, type GapCause } from "./chart-gaps.ts";
export function chartGapQuality(
  candles: Candle[],
  from: number,
  to: number,
  timeframe: number,
) {
  const byTime = new Map(candles.map((c) => [c.timestamp, c])),
    audits = new Map(auditedChartGaps.map((a) => [a.timestamp, a]));
  const entries: {
    timestamp: number;
    cause: GapCause;
    reconstructed: boolean;
    reason: string;
  }[] = [];
  let received = 0,
    reconstructed = 0,
    unknown = 0;
  for (let t = from; t < to; t += timeframe) {
    const c = byTime.get(t),
      audit = timeframe === 300 ? audits.get(t) : undefined;
    if (c) {
      received++;
      if (c.provenance && c.provenance.origin !== "ORIGINAL") {
        reconstructed++;
        entries.push({
          timestamp: t,
          cause: audit?.cause ?? "UNKNOWN",
          reconstructed: true,
          reason: audit
            ? gapCauseLabels[audit.cause]
            : "既存の検証済みprovenanceを参照",
        });
      }
    } else {
      const cause = audit?.cause ?? "UNKNOWN";
      if (cause === "UNKNOWN") unknown++;
      entries.push({
        timestamp: t,
        cause,
        reconstructed: false,
        reason: gapCauseLabels[cause],
      });
    }
  }
  return {
    expected: Math.ceil((to - from) / timeframe),
    received,
    missing: Math.ceil((to - from) / timeframe) - received,
    reconstructed,
    unknown,
    entries,
  };
}
