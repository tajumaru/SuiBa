import {
  compareBacktests,
  type ComparisonInput,
  type RunResult,
} from "./index.ts";
import { BookAwareStrategy } from "../../strategy-engine/src/index.ts";
import { analyzeBook } from "../../market-data/src/book-analysis.ts";
import { observationAt } from "./book-observation-search.ts";
import type { Book } from "../../market-data/src/deepbook.ts";
import {
  defaults,
  type Candle,
  type Settings,
} from "../../shared/src/index.ts";

export interface BookObservation {
  observedAt: number;
  healthy: boolean;
  book: Book | null;
}
/** Offline only. Availability time, not exchange timestamp alone, determines admissibility. */
export async function compareStrategies(
  candles: Candle[],
  options: ComparisonInput,
  observations: BookObservation[],
  settings: Settings = defaults,
) {
  const dataset = structuredClone(candles),
    comparisonOptions = structuredClone(options),
    baseSettings = structuredClone(settings);
  const saved = structuredClone(observations);
  if (
    saved.some(
      (o, i) =>
        !Number.isFinite(o.observedAt) ||
        (i > 0 && o.observedAt <= saved[i - 1].observedAt),
    )
  )
    throw new Error("OBSERVATIONS_NOT_CHRONOLOGICAL");
  let covered = 0,
    evaluated = 0;
  const baseline = await compareBacktests(
    dataset,
    comparisonOptions,
    baseSettings,
  );
  const candidate = await compareBacktests(
    dataset,
    comparisonOptions,
    baseSettings,
    {
      strategyFactory: (s) => ({
        analyze: async (c) => {
          // No later observation can backfill an earlier decision. Failed observations invalidate old books.
          const observation = observationAt(saved, c.now);
          let book = null;
          try {
            if (observation?.healthy && observation.book)
              book = analyzeBook(
                observation.book,
                c.now,
                [s.maxOrder / c.candles.at(-1)!.close],
                s.maxSlippage,
              );
          } catch {
            /* Missing coverage is explicit, never synthetic historical liquidity. */
          }
          if (s.profitGuardEnabled) {
            evaluated++;
            if (book) covered++;
          }
          return new BookAwareStrategy(s).analyze({ ...c, book });
        },
      }),
    },
  );
  const report = (run: RunResult) => {
    const sells = run.events.flatMap((e) =>
      e.trade?.side === "SELL" ? [e.trade.pnl ?? 0] : [],
    );
    return {
      ...run,
      summary: {
        ...run.summary,
        winRate: sells.length ? run.summary.winRate : null,
      },
      signalCounts: {
        BUY: run.events.filter((e) => e.decision.action === "BUY").length,
        SELL: run.events.filter((e) => e.decision.action === "SELL").length,
        WAIT: run.events.filter((e) => e.decision.action === "WAIT").length,
      },
      averageNetSellPnl: sells.length
        ? sells.reduce((a, b) => a + b, 0) / sells.length
        : null,
      skipReasons: run.events
        .filter((e) => !e.trade)
        .reduce<Record<string, number>>((a, e) => {
          for (const reason of e.reasons) a[reason] = (a[reason] ?? 0) + 1;
          return a;
        }, {}),
    };
  };
  return {
    version: 1,
    mode: "PAPER",
    baseline: report(baseline.on),
    candidate: report(candidate.on),
    coverage: {
      evaluated,
      covered,
      fraction: evaluated ? covered / evaluated : 0,
    },
    limitations: [
      "Synthetic next-open quotes include configured fees, gas, spread and impact; not executable historical prices.",
      "Book snapshots must have been observed by decision time and be at most 10 seconds old.",
      "No calibrated win probability. Missing coverage is not evidence of improved performance.",
      "Offline replay checks missing-book inhibition; transport recovery safety is tested separately with mocks.",
    ],
  };
}
