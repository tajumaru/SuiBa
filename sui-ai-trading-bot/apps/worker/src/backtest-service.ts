import { randomUUID } from "node:crypto";
import type { BotDatabase } from "../../../packages/database/src/index.ts";
import {
  compareBacktests,
  comparisonOptionsSchema,
} from "../../../packages/backtest-engine/src/index.ts";

export const backtestMetadata = (db: BotDatabase) => {
  const c = db.candles();
  return {
    count: c.length,
    first: c[0]?.timestamp ?? null,
    last: c.at(-1)?.timestamp ?? null,
    source: c[0]?.source ?? null,
    timeframe: c[0]?.timeframe ?? 300,
    earliestStart: c[61]?.timestamp ?? null,
    latest: db.history("backtest_runs", 1)[0] ?? null,
  };
};
export async function savedComparison(db: BotDatabase, body: unknown) {
  const options = comparisonOptionsSchema.parse(body);
  const result = await compareBacktests(db.candles(), options, db.settings());
  // Only append to an isolated report table; never touch live PAPER portfolio/runtime/settings.
  db.append("backtest_runs", randomUUID(), result);
  return result;
}
